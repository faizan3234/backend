import logging
import time
from typing import Callable, Generator, Optional
import pyaudio

from audio_devices import resolve_capture_device
from config import BYTES_PER_FRAME, SAMPLE_RATE, MIC_DEVICE_HINT

logger = logging.getLogger("reliv_voice.capture")


# ---- Fallback sample rates to try if the primary SAMPLE_RATE fails ----
FALLBACK_RATES = [SAMPLE_RATE, 48000, 44100, 32000, 22050, 16000, 8000]


def _resample_pcm16_mono(pcm_bytes: bytes, src_rate: int, dst_rate: int) -> bytes:
    """
    Linear-interpolation resampler for 16-bit mono PCM.
    Good enough for speech at 16 kHz. No external deps.
    """
    if src_rate == dst_rate or not pcm_bytes:
        return pcm_bytes

    import array
    src = array.array("h")
    src.frombytes(pcm_bytes)
    n_src = len(src)
    if n_src < 2:
        return pcm_bytes

    ratio = dst_rate / float(src_rate)
    n_dst = int(n_src * ratio)
    dst = array.array("h", [0] * n_dst)

    for i in range(n_dst):
        # Position in source samples
        pos = i / ratio
        idx = int(pos)
        frac = pos - idx
        if idx + 1 < n_src:
            s0 = src[idx]
            s1 = src[idx + 1]
            val = s0 + (s1 - s0) * frac
        else:
            val = src[idx]
        # Clamp to int16 range
        if val > 32767:
            val = 32767
        elif val < -32768:
            val = -32768
        dst[i] = int(val)

    return dst.tobytes()


def find_pyaudio_input_device(pa, hint="PCM2902"):
    try:
        count = pa.get_device_count()
    except Exception:
        return (None, "default")
    hint_lower = (hint or "").lower()
    candidates = [hint_lower, "pcm2902", "usb audio", "codec", "usb", "mic"]
    for target in candidates:
        if not target:
            continue
        for i in range(count):
            try:
                info = pa.get_device_info_by_index(i)
                channels = int(info.get("maxInputChannels", 0))
                name = str(info.get("name", ""))
                if channels > 0 and target in name.lower():
                    logger.info("Matched PyAudio input device [%d]: %s (channels: %d)", i, name, channels)
                    return (i, name)
            except Exception:
                pass
    try:
        default_info = pa.get_default_input_device_info()
        idx = default_info.get("index")
        name = default_info.get("name", "Default")
        logger.info("Using default PyAudio input device [%d]: %s", idx, name)
        return (idx, name)
    except Exception:
        pass
    for i in range(count):
        try:
            info = pa.get_device_info_by_index(i)
            if int(info.get("maxInputChannels", 0)) > 0:
                name = str(info.get("name", ""))
                logger.info("Using first available PyAudio input device [%d]: %s", i, name)
                return (i, name)
        except Exception:
            pass
    return (None, "default")


class AudioCaptureStream:
    """
    Manages continuous audio capture from the system microphone using PyAudio.
    Handles hardware sample-rate mismatch by opening at a supported rate and
    resampling in software to SAMPLE_RATE (e.g. 16000 Hz for Whisper).
    """

    def __init__(
        self,
        on_mic_status: Optional[Callable[[bool, str, Optional[str]], None]] = None,
    ):
        self.on_mic_status = on_mic_status
        self._device_id = ""
        self._device_name = ""
        self.pa = pyaudio.PyAudio()

    def _notify_status(self, connected: bool, error: Optional[str] = None):
        if self.on_mic_status:
            try:
                self.on_mic_status(connected, self._device_name or self._device_id, error)
            except Exception:
                pass

    def _open_stream(self, dev_idx, open_rate: int):
        """Try to open the PyAudio stream at the given rate. Raises on failure."""
        open_kwargs = {
            "format": pyaudio.paInt16,
            "channels": 1,
            "rate": open_rate,
            "input": True,
            "frames_per_buffer": int(BYTES_PER_FRAME / 2),
        }
        if dev_idx is not None:
            open_kwargs["input_device_index"] = dev_idx
        return self.pa.open(**open_kwargs)

    def _open_stream_with_fallback(self, dev_idx):
        """
        Try SAMPLE_RATE first; if the hardware rejects it, fall back through
        FALLBACK_RATES until one works. Returns (stream, actual_open_rate).
        """
        last_exc = None
        tried = set()
        for rate in FALLBACK_RATES:
            if rate in tried:
                continue
            tried.add(rate)
            try:
                stream = self._open_stream(dev_idx, rate)
                if rate != SAMPLE_RATE:
                    logger.warning(
                        "Hardware rejected %d Hz; opened at %d Hz and will resample to %d Hz.",
                        SAMPLE_RATE, rate, SAMPLE_RATE,
                    )
                else:
                    logger.info("Capture opened at %d Hz (native match).", rate)
                return stream, rate
            except Exception as exc:
                last_exc = exc
                logger.debug("Open at %d Hz failed: %s", rate, exc)
        raise RuntimeError(f"Could not open capture stream at any rate: {last_exc}")

    def stream_frames(self, stop_event) -> Generator[bytes, None, None]:
        """
        Continuously yields raw PCM audio frames (at SAMPLE_RATE, 16-bit mono)
        until stop_event is set.
        """
        while not stop_event.is_set():
            self._device_id, self._device_name = resolve_capture_device()
            dev_idx, dev_matched_name = find_pyaudio_input_device(self.pa, MIC_DEVICE_HINT)
            if dev_matched_name and dev_matched_name != "default":
                self._device_name = dev_matched_name
            logger.info(
                "Starting capture on device: %s (%s), PyAudio idx=%s",
                self._device_id, self._device_name, dev_idx
            )

            stream = None
            open_rate = SAMPLE_RATE
            try:
                stream, open_rate = self._open_stream_with_fallback(dev_idx)
                self._notify_status(True, None)

                need_resample = (open_rate != SAMPLE_RATE)
                # Compute how many source frames to read to get ~BYTES_PER_FRAME at target rate.
                frames_to_read = int(BYTES_PER_FRAME / 2)
                if need_resample:
                    frames_to_read = int(
                        round(frames_to_read * (open_rate / float(SAMPLE_RATE)))
                    )

                while not stop_event.is_set():
                    try:
                        frame = stream.read(frames_to_read, exception_on_overflow=False)
                        if not frame:
                            break
                        if need_resample:
                            frame = _resample_pcm16_mono(frame, open_rate, SAMPLE_RATE)
                        yield frame
                    except IOError as e:
                        logger.warning("Audio capture stream underrun or error: %s", e)
                        break

            except Exception as exc:
                logger.error("Failed to start or stream audio capture: %s", exc)
                self._notify_status(False, str(exc))
                time.sleep(2)
            finally:
                if stream:
                    try:
                        stream.stop_stream()
                        stream.close()
                    except Exception:
                        pass

            if not stop_event.is_set():
                self._notify_status(False, "Capture device disconnected, reconnecting...")
                time.sleep(1)
