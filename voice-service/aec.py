"""
Acoustic Echo Suppression & Barge-In Controller.

Coordinates speaker-state awareness to prevent the RELIV kiosk's own voice
output from feeding back into the microphone and generating false transcripts.
"""
import threading
import time
from config import ALLOW_BARGE_IN


class EchoController:
    """
    Tracks RELIV speaker activity and determines whether incoming mic frames
    should be suppressed or processed.
    """

    def __init__(self, allow_barge_in: bool = ALLOW_BARGE_IN):
        self.allow_barge_in = allow_barge_in
        self._lock = threading.RLock()
        self.speaking_clients = set()
        self.suppressed_frame_count = 0
        self.speaker_guard_until = 0.0

    def set_reliv_speaking(self, client_id, is_speaking: bool):
        """Called when a client starts or stops audio playback."""
        with self._lock:
            if is_speaking:
                self.speaking_clients.add(client_id)
            else:
                self.speaking_clients.discard(client_id)
                self.speaker_guard_until = time.monotonic() + 0.25

    def remove_client(self, client_id):
        """Called when a client disconnects."""
        with self._lock:
            if client_id in self.speaking_clients:
                self.speaking_clients.discard(client_id)
                self.speaker_guard_until = time.monotonic() + 0.25
            else:
                self.speaking_clients.discard(client_id)

    def should_suppress_mic(self) -> bool:
        """
        Returns True if incoming mic frames should be ignored because RELIV is
        currently speaking and hardware/software barge-in echo cancellation is not active.
        """
        if self.allow_barge_in:
            return False
        with self._lock:
            return len(self.speaking_clients) > 0 or time.monotonic() < self.speaker_guard_until

    def record_suppression(self):
        """Increments internal counter for metrics/debugging."""
        self.suppressed_frame_count += 1
