"""
Acoustic Echo Suppression & Barge-In Controller.

Coordinates speaker-state awareness to prevent the RELIV kiosk's own voice
output from feeding back into the microphone and generating false transcripts.
"""
from config import ALLOW_BARGE_IN


class EchoController:
    """
    Tracks RELIV speaker activity and determines whether incoming mic frames
    should be suppressed or processed.
    """

    def __init__(self, allow_barge_in: bool = ALLOW_BARGE_IN):
        self.allow_barge_in = allow_barge_in
        self.reliv_speaking = False
        self.suppressed_frame_count = 0

    def set_reliv_speaking(self, is_speaking: bool):
        """Called when RELIV starts or stops audio playback."""
        self.reliv_speaking = bool(is_speaking)

    def should_suppress_mic(self) -> bool:
        """
        Returns True if incoming mic frames should be ignored because RELIV is
        currently speaking and hardware/software barge-in echo cancellation is not active.
        """
        if self.allow_barge_in:
            return False
        return self.reliv_speaking

    def record_suppression(self):
        """Increments internal counter for metrics/debugging."""
        self.suppressed_frame_count += 1
