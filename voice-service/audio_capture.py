import logging
import time
from typing import Callable, Generator, Optional
import pyaudio

from audio_devices import resolve_capture_device
from config import BYTES_PER_FRAME, SAMPLE_RATE

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
            logger.info("Starting capture on device: %s (%s)", self._device_id, self._device_name)
            
            stream = None
            try:
                # Try to use default input device (PyAudio abstracts the OS-level devices)
                stream = self.pa.open(
                    format=pyaudio.paInt16,
                    channels=1,
                    rate=SAMPLE_RATE,
                    input=True,
                    frames_per_buffer=int(BYTES_PER_FRAME / 2)  # 2 bytes per sample
                )
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
