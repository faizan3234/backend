"""
RELIV Kiosk Offline Speaker Audio Output / TTS Engine.

Plays localized speech feedback through the kiosk speaker when an intent is recognized.
Safely interfaces with EchoController to mute the mic while the speaker is active,
preventing self-retriggering audio feedback loops.
"""
import logging
import os
import shutil
import subprocess
import threading
from typing import Optional

logger = logging.getLogger("reliv_voice.speaker")

# Supported voice codes for espeak-ng / system TTS
ESPEAK_VOICE_MAP = {
    "hi": "hi",       # Hindi
    "bn": "bn",       # Bengali
    "en": "en-in",    # Indian English
}


class SpeakerTTS:
    """
    Manages offline speaker voice playback on the Raspberry Pi kiosk.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._current_process: Optional[subprocess.Popen] = None
        self._tts_cmd = self._find_available_tts()
        if self._tts_cmd:
            logger.info("Found local offline TTS engine: %s", self._tts_cmd)
        else:
            logger.info("No local CLI TTS found (e.g. espeak-ng). Spoken replies will be played via frontend Web Speech API.")

    def _find_available_tts(self) -> Optional[str]:
        for cmd in ["espeak-ng", "espeak", "pico2wave", "spd-say"]:
            if shutil.which(cmd):
                return cmd
        return None

    def is_available(self) -> bool:
        return self._tts_cmd is not None

    def stop(self):
        with self._lock:
            if self._current_process and self._current_process.poll() is None:
                try:
                    self._current_process.terminate()
                except Exception:
                    pass
                self._current_process = None

    def speak_async(self, text: str, language: str = "en", echo_controller=None):
        """
        Speaks text asynchronously through the local speaker without blocking the caller.
        Coordinates with echo_controller to mute the microphone while speaking.
        """
        if not text or not text.strip():
            return

        thread = threading.Thread(
            target=self._speak_worker,
            args=(text.strip(), language, echo_controller),
            daemon=True,
            name="reliv-speaker-worker",
        )
        thread.start()

    def _speak_worker(self, text: str, language: str, echo_controller):
        if not self._tts_cmd:
            return

        lang_code = str(language or "en").lower().split("-")[0]
        voice = ESPEAK_VOICE_MAP.get(lang_code, "en-in")

        # Activate speaker gate so mic frames are dropped during playback
        if echo_controller:
            try:
                echo_controller.set_reliv_speaking("local_tts", True)
            except Exception as e:
                logger.debug("Failed setting reliv speaking: %s", e)

        try:
            with self._lock:
                self.stop()
                if self._tts_cmd in {"espeak-ng", "espeak"}:
                    cmd = [self._tts_cmd, "-v", voice, "-s", "145", text]
                elif self._tts_cmd == "spd-say":
                    cmd = ["spd-say", "-l", lang_code, text]
                else:
                    cmd = [self._tts_cmd, text]

                self._current_process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )

            if self._current_process:
                self._current_process.wait(timeout=10.0)

        except subprocess.TimeoutExpired:
            logger.warning("TTS playback timed out after 10s")
            self.stop()
        except Exception as exc:
            logger.warning("Local TTS playback failed: %s", exc)
        finally:
            with self._lock:
                self._current_process = None
            if echo_controller:
                try:
                    echo_controller.set_reliv_speaking("local_tts", False)
                except Exception as e:
                    logger.debug("Failed clearing reliv speaking: %s", e)
