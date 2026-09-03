"""
Voice Activity Detection (VAD) Engine.

Calculates 16-bit PCM frame energy (RMS) and manages state machine transitions
between silence, speech onset (with preroll buffer), active speech, and speech conclusion.
"""
import math
import struct
from collections import deque
from typing import List, Optional, Tuple

from config import (
    FRAME_MS,
    SAMPLE_RATE,
    VAD_END_SILENCE_MS,
    VAD_MAX_UTTERANCE_MS,
    VAD_MIN_SPEECH_MS,
    VAD_PREROLL_MS,
    VAD_RMS,
    VAD_START_FRAMES,
)


def compute_frame_rms(frame: bytes) -> float:
    """
    Computes root-mean-square (RMS) energy for a 16-bit signed PCM mono audio frame.
    """
    if not frame:
        return 0.0
    count = len(frame) // 2
    if count <= 0:
        return 0.0
    samples = struct.unpack("<" + "h" * count, frame)
    total = sum(v * v for v in samples)
    return math.sqrt(total / count)


class VoiceActivityDetector:
    """
    Manages VAD state and utterance buffering over a stream of raw audio frames.
    """

    def __init__(
        self,
        threshold_rms: int = VAD_RMS,
        start_frames: int = VAD_START_FRAMES,
        end_silence_ms: int = VAD_END_SILENCE_MS,
        min_speech_ms: int = VAD_MIN_SPEECH_MS,
        max_utterance_ms: int = VAD_MAX_UTTERANCE_MS,
        preroll_ms: int = VAD_PREROLL_MS,
    ):
        self.threshold_rms = threshold_rms
        self.start_frames_required = start_frames
        self.preroll_frames = max(1, preroll_ms // FRAME_MS)
        self.silence_frames_to_end = max(1, end_silence_ms // FRAME_MS)
        self.min_frames = max(1, min_speech_ms // FRAME_MS)
        self.max_frames = max(1, max_utterance_ms // FRAME_MS)

        self.preroll_buffer = deque(maxlen=self.preroll_frames)
        self.active = False
        self.voiced_run = 0
        self.silence_run = 0
        self.current_utterance: List[bytes] = []

    def reset(self):
        """Resets VAD tracking state and clears buffers."""
        self.active = False
        self.voiced_run = 0
        self.silence_run = 0
        self.current_utterance.clear()
        self.preroll_buffer.clear()

    def process_frame(
        self, frame: bytes
    ) -> Tuple[Optional[str], float, Optional[List[bytes]]]:
        """
        Processes a single audio frame through VAD.

        Returns:
            (event, rms, completed_utterance)
            event:
                - "SPEECH_STARTED": Speech triggered after reaching consecutive start threshold
                - "SPEECH_ENDED": Utterance completed after silence or max duration
                - None: No state transition
            rms:
                Current frame RMS energy
            completed_utterance:
                List of frames if event == "SPEECH_ENDED", otherwise None
        """
        level = compute_frame_rms(frame)
        is_voiced = level >= self.threshold_rms

        if not self.active:
            self.preroll_buffer.append(frame)
            if is_voiced:
                self.voiced_run += 1
            else:
                self.voiced_run = 0

            if self.voiced_run >= self.start_frames_required:
                self.active = True
                self.current_utterance = list(self.preroll_buffer)
                self.silence_run = 0
                return ("SPEECH_STARTED", level, None)

            return (None, level, None)

        # Active speech state
        self.current_utterance.append(frame)
        if is_voiced:
            self.silence_run = 0
        else:
            self.silence_run += 1

        has_min_speech = len(self.current_utterance) >= self.min_frames
        silence_timeout = has_min_speech and (self.silence_run >= self.silence_frames_to_end)
        max_duration_reached = len(self.current_utterance) >= self.max_frames

        if silence_timeout or max_duration_reached:
            completed = self.current_utterance[:]
            self.reset()
            return ("SPEECH_ENDED", level, completed)

        return (None, level, None)
