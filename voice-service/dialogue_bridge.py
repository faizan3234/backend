"""
Dialogue Bridge & Protocol Formatter.

Normalizes incoming WebSocket messages from the React kiosk frontend and
constructs standard JSON event payloads matching the RELIV Voice Protocol.
"""
import time
from typing import Any, Dict, List, Optional, Tuple


class DialogueBridge:
    """
    Protocol adapter between Python voice backend and React frontend.
    """

    @staticmethod
    def parse_client_message(msg: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """
        Parses incoming JSON message from frontend and extracts standardized action.
        Supports both modern V2 protocol and legacy commands.
        """
        msg_type = str(msg.get("type", "")).strip().lower()

        if msg_type == "set_language":
            lang = str(msg.get("language", "auto")).strip().lower()
            return ("SET_LANGUAGE", {"language": lang})

        if msg_type == "set_context":
            page = str(msg.get("page", "unknown")).strip()
            expecting = str(msg.get("expecting", "")).strip()
            hints = msg.get("vocabulary_hints", [])
            if not isinstance(hints, list):
                hints = []
            return ("SET_CONTEXT", {"page": page, "expecting": expecting, "vocabulary_hints": hints})

        # Legacy context payload support
        if msg_type == "context":
            page = str(msg.get("page", "unknown")).strip()
            lang = str(msg.get("language", "en")).strip().lower()
            prompt = str(msg.get("prompt", "")).strip()
            return ("SET_CONTEXT_LEGACY", {"page": page, "language": lang, "prompt": prompt})

        if msg_type == "reliv_speaking":
            active = bool(msg.get("active", False))
            return ("SET_RELIV_SPEAKING", {"active": active})

        # Legacy assistant speaking support
        if msg_type == "assistant_speaking":
            active = bool(msg.get("value", False))
            return ("SET_RELIV_SPEAKING", {"active": active})

        if msg_type == "pause_listening":
            return ("PAUSE_LISTENING", {})

        if msg_type == "resume_listening":
            return ("RESUME_LISTENING", {})

        if msg_type == "ping":
            return ("PING", {})

        return ("UNKNOWN", msg)

    @staticmethod
    def make_transcript_event(
        text: str,
        language: str = "en",
        confidence: float = 0.85,
        is_final: bool = True,
        duration_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Constructs standardized transcript event."""
        payload = {
            "type": "transcript",
            "text": text,
            "language": language,
            "confidence": round(confidence, 2),
            "is_final": is_final,
            "timestamp": int(time.time() * 1000),
        }
        if duration_ms is not None:
            payload["durationMs"] = duration_ms
        return payload

    @staticmethod
    def make_vad_event(speaking: bool) -> Dict[str, Any]:
        """Constructs voice activity detection state event."""
        return {
            "type": "vad",
            "speaking": bool(speaking),
            "timestamp": int(time.time() * 1000),
        }

    @staticmethod
    def make_mic_status_event(
        connected: bool,
        device_name: Optional[str] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Constructs microphone hardware status event."""
        return {
            "type": "mic_status",
            "connected": bool(connected),
            "device_name": device_name,
            "error": error,
        }

    @staticmethod
    def make_error_event(code: str, message: str) -> Dict[str, Any]:
        """Constructs standardized error event."""
        return {
            "type": "error",
            "code": code,
            "message": message,
        }

    @staticmethod
    def make_connected_event(device_name: str, allow_barge_in: bool) -> Dict[str, Any]:
        """Constructs initial greeting upon WebSocket connection."""
        return {
            "type": "connected",
            "service": "reliv-voice",
            "device_name": device_name,
            "bargeIn": allow_barge_in,
        }
