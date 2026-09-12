import logging
import time
from typing import Callable, Generator, Optional
import pyaudio

from audio_devices import resolve_capture_device
from config import BYTES_PER_FRAME, SAMPLE_RATE, MIC_DEVICE_HINT

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

logger = logging.getLogger("reliv_voice.capture")


class AudioCaptureStream:
    """
    Manages continuous audio capture from the system microphone using PyAudio.
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

    def stream_frames(self, stop_event) -> Generator[bytes, None, None]:
        """
        Continuously yields raw PCM audio frames until stop_event is set.
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
            try:
                open_kwargs = {
                    "format": pyaudio.paInt16,
                    "channels": 1,
                    "rate": SAMPLE_RATE,
                    "input": True,
                    "frames_per_buffer": int(BYTES_PER_FRAME / 2),
                }
                if dev_idx is not None:
                    open_kwargs["input_device_index"] = dev_idx
                stream = self.pa.open(**open_kwargs)
                self._notify_status(True, None)

                while not stop_event.is_set():
                    try:
                        frame = stream.read(int(BYTES_PER_FRAME / 2), exception_on_overflow=False)
                        if not frame:
                            break
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
                    stream.stop_stream()
                    stream.close()

            if not stop_event.is_set():
                self._notify_status(False, "Capture device disconnected, reconnecting...")
                time.sleep(1)
