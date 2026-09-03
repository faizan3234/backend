"""
Speech Session & Context State Manager.

Tracks dynamic dialogue state (current page, language preference, vocabulary hints,
barge-in status) and safely persists in-memory WAV utterances to temporary files
for whisper inference.
"""
import os
import tempfile
import threading
import wave
from typing import Any, Dict, List, Optional

from config import CHANNELS, SAMPLE_RATE, SAMPLE_WIDTH


class SpeechSessionState:
    """
    Thread-safe storage for frontend-provided conversational context.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.page = "unknown"
        self.language = "en"
        self.expecting = ""
        self.vocabulary_hints: List[str] = []
        self.prompt = ""
        self.listening_paused = False

    def update_context(
        self,
        page: Optional[str] = None,
        expecting: Optional[str] = None,
        hints: Optional[List[str]] = None,
    ):
        with self._lock:
            if page is not None:
                self.page = page
            if expecting is not None:
                self.expecting = expecting
            if hints is not None:
                self.vocabulary_hints = hints

    def set_language(self, language: str):
        with self._lock:
            norm = language.strip().lower()
            self.language = norm if norm in {"en", "hi", "bn", "auto"} else "auto"

    def set_legacy_context(self, page: str, language: str, prompt: str):
        with self._lock:
            self.page = page
            self.language = language if language in {"en", "hi", "bn"} else "en"
            self.prompt = prompt

    def set_listening_paused(self, paused: bool):
        with self._lock:
            self.listening_paused = bool(paused)

    def is_paused(self) -> bool:
        with self._lock:
            return self.listening_paused

    def get_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "page": self.page,
                "language": self.language,
                "expecting": self.expecting,
                "vocabulary_hints": list(self.vocabulary_hints),
                "prompt": self.prompt,
                "listening_paused": self.listening_paused,
            }


def write_frames_to_temp_wav(frames: List[bytes]) -> str:
    """
    Encodes raw 16-bit PCM frames into a temporary WAV file.
    Returns absolute path to the temp file.
    """
    fd, path = tempfile.mkstemp(prefix="reliv_voice_", suffix=".wav")
    os.close(fd)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(frames))
    return path


def safe_delete_file(path: Optional[str]):
    """Safely removes temporary audio file if it exists."""
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except OSError:
            pass
