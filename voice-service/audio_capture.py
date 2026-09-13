"""
audio_capture.py

Continuous microphone capture with automatic hardware sample-rate fallback
and software resampling to SAMPLE_RATE (typically 16000 Hz for Whisper).

Design notes
------------
* Opens the PyAudio stream ONCE per device and keeps it open. Only reopens
  if the read loop raises or the device disappears.
* If the USB hardware rejects SAMPLE_RATE (common on Pi + PCM2902 / UAC1
  mics that only do 44100/48000), we open at the closest supported rate
  and resample to SAMPLE_RATE in software.
* Frame sizes are computed from the open rate so each yielded frame has
  the same duration regardless of the underlying hardware rate.
"""
from __future__ import annotations

import logging
from typing import Callable, Generator, Optional

import pyaudio

from audio_devices import resolve_capture_device
from config import BYTES_PER_FRAME, SAMPLE_RATE, MIC_DEVICE_HINT, MIC_DEVICE_FALLBACK

logger = logging.getLogger("reliv_voice.capture")


# Sample-rate candidates, ordered by preference. SAMPLE_RATE first as the
# fast path; then common hardware rates; then narrow-band fallbacks.
_FALLBACK_RATES = tuple(dict.fromkeys([
    SAMPLE_RATE, 48000, 44100, 32000, 22050, 16000, 8000,
]))

# Reconnect backoff ladder (seconds). Caps so a dead mic doesn't spam.
_RECONNECT_BACKOFF = (1.0, 2.0, 5.0, 10.0)


# ---------------------------------------------------------------------------
# Resampling
# ---------------------------------------------------------------------------

def _make_resampler(src_rate: int, dst_rate: int) -> Callable[[bytes], bytes]:
    """
    Return a function that converts a 16-bit mono PCM byte buffer from
    src_rate to dst_rate. Uses scipy if available (high quality); otherwise
    a vectorized pure-Python fallback.
    """
    if src_rate == dst_rate:
        return lambda b: b

    # ---- Preferred: scipy.signal.resample_poly ----
    try:
        import numpy as np
        from scipy.signal import resample_poly
        from math import gcd

        g = gcd(src_rate, dst_rate)
        up, down = dst_rate // g, src_rate // g

        def _resample_scipy(pcm_bytes: bytes) -> bytes:
            if not pcm_bytes:
                return pcm_bytes
            x = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32)
            y = resample_poly(x, up, down)
            # Clip to int16 range and convert back.
            y = np.clip(y, -32768, 32767).astype("<i2", copy=False)
            return y.tobytes()

        logger.info(
            "Resampler: scipy.signal.resample_poly (%d -> %d Hz, up=%d down=%d)",
            src_rate, dst_rate, up, down,
        )
        return _resample_scipy
    except Exception:
        pass

    # ---- Fallback: vectorized linear interpolation in pure Python ----
    import array

    def _resample_py(pcm_bytes: bytes) -> bytes:
        if not pcm_bytes:
            return pcm_bytes
        src = array.array("h")
        src.frombytes(pcm_bytes)
        n_src = len(src)
        if n_src < 2:
            return pcm_bytes

        ratio = dst_rate / float(src_rate)
        n_dst = int(n_src * ratio)
        dst = array.array("h", bytes(2 * n_dst))

        # Vectorized-ish: integer index + fractional weight.
        for i in range(n_dst):
            pos = i / ratio
            idx = int(pos)
            frac = pos - idx
            if idx + 1 < n_src:
                s0 = src[idx]
                s1 = src[idx + 1]
                v = s0 + (s1 - s0) * frac
            else:
                v = src[idx]
            if v > 32767:
                v = 32767
            elif v < -32768:
                v = -32768
            dst[i] = int(v)

        return dst.tobytes()

    logger.warning(
        "Resampler: pure-Python fallback (%d -> %d Hz). "
        "Install scipy for better quality: pip install scipy",
        src_rate, dst_rate,
    )
    return _resample_py


# ---------------------------------------------------------------------------
# Device discovery
# ---------------------------------------------------------------------------

def is_microphone_input(info):
    name = str(info.get("name", "")).lower()
    return int(info.get("maxInputChannels", 0)) > 0 and not any(
        marker in name for marker in ("monitor", "loopback", "stereo mix", "what u hear")
    )


def find_pyaudio_input_device(pa: pyaudio.PyAudio, hint: str = "PCM2902"):
    """Prefer the configured ALSA plug PCM, without accepting output monitors."""
    devices = []
    for index in range(pa.get_device_count()):
        try:
            info = pa.get_device_info_by_index(index)
            if is_microphone_input(info):
                devices.append((index, str(info.get("name", ""))))
        except Exception:
            continue
    # Preserve the Pi's reliv_mic plug conversion and stable RELIV_MIC routing.
    for index, name in devices:
        if name.lower() == MIC_DEVICE_FALLBACK.lower():
            return index, name
    try:
        default = pa.get_default_input_device_info()
        if isinstance(default, dict) and isinstance(default.get("index"), int) and is_microphone_input(default):
            return default.get("index"), str(default.get("name", "default"))
    except Exception:
        pass
    for target in ["reliv_mic", (hint or "").lower(), "pcm2902", "usb audio", "usb", "mic", "codec"]:
        if target:
            for index, name in devices:
                if target in name.lower():
                    return index, name
    if devices:
        return devices[0]
    raise RuntimeError("No microphone input found; speaker loopback is not a microphone")


# ---------------------------------------------------------------------------
# Capture stream
# ---------------------------------------------------------------------------

class AudioCaptureStream:
    """
    Continuous microphone capture. Yields fixed-size 16-bit mono PCM frames
    at SAMPLE_RATE, resampling from the hardware rate if necessary.
    """

    def __init__(
        self,
        on_mic_status: Optional[Callable[[bool, str, Optional[str]], None]] = None,
    ):
        self.on_mic_status = on_mic_status
        self._device_id = ""
        self._device_name = ""
        self.pa = pyaudio.PyAudio()

    # -- helpers ------------------------------------------------------------

    def _notify_status(self, connected: bool, error: Optional[str] = None) -> None:
        if not self.on_mic_status:
            return
        try:
            self.on_mic_status(
                connected,
                self._device_name or self._device_id,
                error,
            )
        except Exception:
            logger.debug("on_mic_status callback raised", exc_info=True)

    def _open_stream(self, dev_idx: Optional[int], rate: int):
        kwargs = {
            "format": pyaudio.paInt16,
            "channels": 1,
            "rate": rate,
            "input": True,
            "frames_per_buffer": 1024,  # internal PortAudio buffer, not our frame
        }
        if dev_idx is not None:
            kwargs["input_device_index"] = dev_idx
        return self.pa.open(**kwargs)

    def _open_with_rate_fallback(self, dev_idx: Optional[int]):
        """
        Try _FALLBACK_RATES in order. Return (stream, open_rate) on success.
        Raise RuntimeError if no rate works.
        """
        last_exc: Optional[Exception] = None
        for rate in _FALLBACK_RATES:
            try:
                stream = self._open_stream(dev_idx, rate)
                if rate != SAMPLE_RATE:
                    logger.warning(
                        "Hardware rejected %d Hz; opened at %d Hz and will "
                        "resample to %d Hz.",
                        SAMPLE_RATE, rate, SAMPLE_RATE,
                    )
                else:
                    logger.info("Capture opened at native %d Hz.", rate)
                return stream, rate
            except Exception as exc:
                last_exc = exc
                logger.debug("Open at %d Hz failed: %s", rate, exc)
        raise RuntimeError(
            f"Could not open capture stream at any rate "
            f"({_FALLBACK_RATES}); last error: {last_exc}"
        )

    # -- main loop ----------------------------------------------------------

    def stream_frames(self, stop_event) -> Generator[bytes, None, None]:
        """
        Yield raw PCM frames at SAMPLE_RATE until stop_event is set.
        Reconnects automatically on failure with bounded backoff.
        """
        target_frames = int(BYTES_PER_FRAME / 2)  # frames per yielded chunk at SAMPLE_RATE
        backoff_idx = 0

        while not stop_event.is_set():
            stream = None
            open_rate = SAMPLE_RATE
            resample: Callable[[bytes], bytes] = lambda b: b

            try:
                self._device_id, self._device_name = resolve_capture_device()
                dev_idx, self._device_name = find_pyaudio_input_device(self.pa, MIC_DEVICE_HINT)
                logger.info("Starting capture: %s, PyAudio idx=%s", self._device_name, dev_idx)
                stream, open_rate = self._open_with_rate_fallback(dev_idx)
                resample = _make_resampler(open_rate, SAMPLE_RATE)

                # How many source frames to read so we produce ~target_frames
                # after resampling? For 44100->16000: read 4410, get 1600.
                if open_rate == SAMPLE_RATE:
                    frames_to_read = target_frames
                else:
                    frames_to_read = int(
                        round(target_frames * (open_rate / float(SAMPLE_RATE)))
                    )
                    if frames_to_read < 1:
                        frames_to_read = 1

                self._notify_status(True, None)
                backoff_idx = 0  # reset on successful open

                while not stop_event.is_set():
                    try:
                        raw = stream.read(frames_to_read, exception_on_overflow=False)
                    except IOError as exc:
                        logger.warning("Audio stream IOError: %s", exc)
                        break
                    if not raw:
                        logger.warning("Audio stream returned empty frame; reopening.")
                        break

                    # A partial PCM sample/frame is invalid input for VAD.
                    if len(raw) != frames_to_read * 2:
                        logger.debug("Skipping partial capture frame (%d bytes)", len(raw))
                        continue
                    frame = resample(raw) if open_rate != SAMPLE_RATE else raw
                    if len(frame) == BYTES_PER_FRAME:
                        yield frame

            except Exception as exc:
                logger.error("Audio capture failed: %s", exc)
                self._notify_status(False, str(exc))
            finally:
                if stream is not None:
                    for cleanup in (stream.stop_stream, stream.close):
                        try:
                            cleanup()
                        except Exception:
                            logger.debug("Error closing stream", exc_info=True)

            if stop_event.is_set():
                break

            # Bounded backoff before reconnect.
            delay = _RECONNECT_BACKOFF[min(backoff_idx, len(_RECONNECT_BACKOFF) - 1)]
            backoff_idx += 1
            self._notify_status(False, "Capture device disconnected; reconnecting...")
            logger.info("Reconnecting audio capture in %.1fs", delay)
            stop_event.wait(delay)

    # -- cleanup ------------------------------------------------------------

    def close(self) -> None:
        """Release the PyAudio instance. Call on shutdown."""
        try:
            self.pa.terminate()
        except Exception:
            logger.debug("Error terminating PyAudio", exc_info=True)
