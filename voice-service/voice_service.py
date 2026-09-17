#!/usr/bin/env python3
"""
RELIV Local Voice Capture Service.

Modular local voice engine for the Raspberry Pi kiosk:
- Captures USB / PCM2902 microphone audio frames
- Runs real-time Voice Activity Detection (VAD)
- Performs speaker suppression (AEC / barge-in control)
- Interacts with local whisper.cpp server for en/hi/bn speech recognition
- Communicates with the React kiosk frontend over WebSocket

Authority Boundary:
This service is strictly 'ears + speech recognition'.
All business logic, state machines, payment validation, and screen actions
remain in the React frontend and Node backend.
"""
import asyncio
import errno
import json
import logging
import signal
import sys
import threading
import time
import re
from collections import Counter
from typing import Set

from aec import EchoController
from audio_capture import AudioCaptureStream
from audio_devices import resolve_capture_device
from config import ALLOW_BARGE_IN, ALLOWED_ORIGINS, HOST, PORT
from dialogue_bridge import DialogueBridge
from speech_session import SpeechSessionState, safe_delete_file, write_frames_to_temp_wav
from vad import VoiceActivityDetector
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from whisper_asr import WhisperClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s",
)
logger = logging.getLogger("reliv_voice.main")

from intent_engine import IntentEngine

# State & Services
clients: Set[ServerConnection] = set()
clients_lock = threading.Lock()
active_controller_ws: ServerConnection = None
active_controller_id: str = None

session_state = SpeechSessionState()
echo_controller = EchoController(allow_barge_in=ALLOW_BARGE_IN)
whisper_client = WhisperClient()
intent_engine = IntentEngine()
vad = VoiceActivityDetector()
stop_event = threading.Event()
transcription_busy = threading.Event()
event_loop: asyncio.AbstractEventLoop = None
shutdown_requested: asyncio.Event = None

def is_pathological_transcript(text: str) -> bool:
    text = (text or "").strip()
    if not text:
        return True
    if len(text) > 500:
        return True
    if re.search(r"(.{1,12})\1{5,}", text, flags=re.UNICODE):
        return True
    words = re.findall(r"\w+", text.lower(), flags=re.UNICODE)
    if not words:
        return True
    # Reject huge repetition such as: "I'm not going to be a doctor..." x 20
    if len(words) >= 12:
        trigrams = [tuple(words[i:i + 3]) for i in range(len(words) - 2)]
        if trigrams:
            repeats = Counter(trigrams)
            if max(repeats.values()) >= 4:
                return True
    return False

async def broadcast_event(payload: dict, generation=None):
    """Asynchronously broadcasts a JSON payload only to the active controller."""
    global active_controller_ws
    if not active_controller_ws:
        return
    if generation is not None and (
        session_state.get_generation() != generation
        or session_state.is_paused()
        or echo_controller.should_suppress_mic()
    ):
        return

    raw = json.dumps(payload, ensure_ascii=False)
    try:
        await active_controller_ws.send(raw)
    except Exception:
        pass


def broadcast_threadsafe(payload: dict, generation=None):
    """Thread-safe event broadcast helper from background capture/transcription threads."""
    global event_loop
    if event_loop and not event_loop.is_closed():
        asyncio.run_coroutine_threadsafe(broadcast_event(payload, generation), event_loop)


def on_mic_status(connected: bool, device_name: str, error: str = None):
    """Callback triggered on capture device state changes."""
    event = DialogueBridge.make_mic_status_event(connected, device_name, error)
    broadcast_threadsafe(event)


def async_transcribe_worker(frames: list, started_at: float, original_generation: int):
    """
    Executes Whisper STT in a worker thread and broadcasts the resulting transcript.
    """
    wav_path = None
    try:
        wav_path = write_frames_to_temp_wav(frames)
        ctx = session_state.get_snapshot()

        if session_state.get_generation() != original_generation or ctx["listening_paused"]:
            return
        # ASR is always auto: users can speak English, Hindi, or Bengali regardless of selected UI language
        logger.info("Transcribing utterance (%d frames, UI language: %s, page: %s, expecting: %s)", len(frames), ctx["language"], ctx["page"], ctx["expecting"])
        text, confidence, used_lang = whisper_client.transcribe(
            wav_path=wav_path,
            language="auto",
            prompt=ctx["prompt"] or ctx["page"] or "",
            vocabulary_hints=ctx["vocabulary_hints"],
            expecting=ctx["expecting"],
            target_lang=ctx.get("language") or "auto",
        )

        duration_ms = int((time.monotonic() - started_at) * 1000)

        if session_state.get_generation() != original_generation:
            logger.info("Discarding stale transcript from older generation")
            return

        if not text:
            logger.info("Utterance produced no text output")
            return

        if echo_controller.should_suppress_mic():
            logger.info("Dropping transcript because RELIV speaker gate is active")
            return

        # Collapse repetitive loops e.g. 'haa, haa, haa...' -> 'haan'
        text = re.sub(r"(\b\w+\b)(?:[,\s]+\1\b){2,}", r"\1", text, flags=re.IGNORECASE | re.UNICODE)
        text = re.sub(r"(.{2,15}?)(?:[,\s]*\1){3,}", r"\1", text, flags=re.UNICODE).strip()

        if is_pathological_transcript(text):
            logger.warning("Rejected pathological Whisper transcript: %r", text[:160])
            return

        intent, action, reply = intent_engine.resolve_intent(
            text, expecting=ctx.get("expecting"), language=used_lang
        )
        logger.info(
            "Recognized: '%s' (lang: %s, conf: %.2f) -> Intent: %s, Action: %s, Reply: '%s'",
            text, used_lang, confidence, intent, action, reply or ""
        )
        event = DialogueBridge.make_transcript_event(
            text=text,
            language=used_lang,
            confidence=confidence,
            is_final=True,
            duration_ms=duration_ms,
        )
        event["page"] = ctx["page"]
        event["expecting"] = ctx["expecting"]
        event["intent"] = intent
        event["action"] = action
        event["reply"] = reply
        broadcast_threadsafe(event, original_generation)

    except Exception as exc:
        logger.exception("Transcription failed: %s", exc)
        err_event = DialogueBridge.make_error_event("TRANSCRIPTION_FAILED", str(exc))
        broadcast_threadsafe(err_event)
    finally:
        safe_delete_file(wav_path)
        transcription_busy.clear()
        broadcast_threadsafe({"type": "processing", "active": False})

def capture_loop_worker():
    """
    Continuously streams frames from microphone, applies echo suppression,
    runs VAD, and dispatches speech events.
    """
    stream = AudioCaptureStream(on_mic_status=on_mic_status)
    started_at = 0.0
    utterance_generation = session_state.get_generation()

    try:
        for frame in stream.stream_frames(stop_event):
            if stop_event.is_set():
                break

            generation = session_state.get_generation()
            if generation != utterance_generation:
                vad.reset()
                utterance_generation = generation

            # 1. Check listening paused by frontend
            if session_state.is_paused():
                vad.reset()
                continue

            # 2. Check echo suppression (RELIV speaker active and barge-in disabled)
            if echo_controller.should_suppress_mic():
                echo_controller.record_suppression()
                vad.reset()
                continue

            # 3. Whisper is processing the previous answer
            if transcription_busy.is_set():
                vad.reset()
                continue

            # 4. Process frame through VAD
            vad.update_context(session_state.get_snapshot()["expecting"])
            event, level, completed_frames = vad.process_frame(frame)

            if event == "SPEECH_STARTED":
                started_at = time.monotonic()
                logger.debug("Speech started (RMS: %.1f)", level)
                broadcast_threadsafe(DialogueBridge.make_vad_event(speaking=True))

            elif event == "SPEECH_ENDED":
                logger.debug("Speech ended (%d frames)", len(completed_frames) if completed_frames else 0)
                broadcast_threadsafe(DialogueBridge.make_vad_event(speaking=False))

                if completed_frames:
                    if transcription_busy.is_set():
                        logger.info("Dropping utterance: transcription already in progress")
                        continue

                    transcription_busy.set()
                    broadcast_threadsafe({"type": "processing", "active": True})

                    # Dispatch transcription to background thread to avoid blocking capture
                    threading.Thread(
                        target=async_transcribe_worker,
                        args=(completed_frames, started_at, utterance_generation),
                        daemon=True,
                        name="WhisperTranscriptionWorker",
                    ).start()
    finally:
        stream.close()


async def ws_handler(websocket: ServerConnection):
    """
    Handles incoming WebSocket connections and messages from React frontend.
    """
    global active_controller_ws, active_controller_id

    logger.info("Client connected; awaiting CLIENT_HELLO handshake.")
    with clients_lock:
        clients.add(websocket)

    try:
        _, dev_name = resolve_capture_device()
        greeting = DialogueBridge.make_connected_event(dev_name, echo_controller.allow_barge_in)
        greeting["processing"] = transcription_busy.is_set()
        await websocket.send(json.dumps(greeting))
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            action, data = DialogueBridge.parse_client_message(msg)

            if action == "CLIENT_HELLO":
                if data["role"] != "kiosk-controller" or not data["clientId"]:
                    continue
                client_id = data["clientId"]
                # A second HTTP kiosk tab may not have navigator.locks. Keep
                # the live controller instead of letting reconnects steal it.
                if active_controller_ws and active_controller_ws != websocket:
                    await websocket.send(json.dumps({"type": "CONTROLLER_BUSY"}))
                    await websocket.close(code=1013, reason="A kiosk controller is already active")
                    return

                already_active = active_controller_ws == websocket
                with clients_lock:
                    active_controller_ws = websocket
                    active_controller_id = client_id
                    logger.info("Active controller registered: %s", client_id)

                if not already_active:
                    session_state.force_resume()

                await websocket.send(json.dumps({"type": "CONTROLLER_ACTIVE", "clientId": client_id}))
                continue

            if websocket != active_controller_ws:
                if action not in ("PING", "UNKNOWN"):
                    logger.debug("Ignoring command from inactive socket: %s", action)
                continue

            if action == "SET_LANGUAGE":
                session_state.set_language(data["language"])
                logger.info("Updated language preference: %s", data["language"])

            elif action == "SET_CONTEXT":
                session_state.update_context(
                    page=data.get("page"),
                    expecting=data.get("expecting"),
                    hints=data.get("vocabulary_hints"),
                )
                logger.debug("Updated context: %s, expecting: %s", data.get("page"), data.get("expecting"))

            elif action == "SET_CONTEXT_LEGACY":
                session_state.set_legacy_context(
                    page=data["page"],
                    language=data["language"],
                    prompt=data["prompt"],
                )

            elif action == "SET_RELIV_SPEAKING":
                active = bool(data["active"])
                echo_controller.set_reliv_speaking(id(websocket), active)
                if active:
                    session_state.increment_generation()
                logger.debug("RELIV speaking state set to: %s by client %s", active, id(websocket))

            elif action == "PAUSE_LISTENING":
                session_state.set_listening_paused(True)
                logger.info("Listening paused by frontend")

            elif action == "RESUME_LISTENING":
                session_state.set_listening_paused(False)
                logger.info("Listening resumed by frontend")

            elif action == "PING":
                await websocket.send(json.dumps({"type": "pong"}))

    except ConnectionClosed as exc:
        logger.warning(
            "Controller socket closed: client=%s code=%s reason=%r",
            active_controller_id,
            exc.code,
            exc.reason,
        )
    except Exception as exc:
        logger.exception("Controller websocket failed: client=%s", active_controller_id)
    finally:
        with clients_lock:
            clients.discard(websocket)
            if websocket == active_controller_ws:
                logger.info("Active controller disconnected.")
                active_controller_ws = None
                active_controller_id = None
                # Clean up speaker state and retain the guard
                echo_controller.remove_client(id(websocket))

        # Fallback to remove client if not active
        echo_controller.remove_client(id(websocket))


async def main():
    global event_loop, shutdown_requested
    event_loop = asyncio.get_running_loop()
    shutdown_requested = asyncio.Event()
    stop_event.clear()
    capture_thread = None

    try:
        # Bind before touching the microphone. A second process must not open
        # PortAudio or contend with the running service's capture device.
        async with serve(
            ws_handler,
            HOST,
            PORT,
            origins=ALLOWED_ORIGINS,
            max_size=1_000_000,
            ping_interval=10,
            ping_timeout=30,
            close_timeout=2,
        ):
            try:
                capture_thread = threading.Thread(
                    target=capture_loop_worker, daemon=True, name="AudioCaptureWorker"
                )
                capture_thread.start()
                logger.info("RELIV voice service listening on ws://%s:%d", HOST, PORT)
                await shutdown_requested.wait()
            finally:
                stop_event.set()
        return 0
    except OSError as exc:
        if exc.errno != errno.EADDRINUSE or capture_thread is not None:
            raise
        logger.error(
            "Cannot start voice service: %s:%d is already in use. "
            "Another voice process may be running. Check: "
            "systemctl status reliv-voice.service --no-pager ; "
            "sudo ss -ltnp 'sport = :%d' . "
            "If reliv-voice.service owns the port, use "
            "sudo systemctl restart reliv-voice.service instead of starting "
            "another python voice_service.py process. The microphone was not opened.",
            HOST, PORT, PORT,
        )
        return 1
    finally:
        stop_event.set()
        if capture_thread is not None and capture_thread.is_alive():
            # Let normal capture cleanup finish, but do not hang shutdown if a
            # disconnected USB driver has blocked its read indefinitely.
            await asyncio.to_thread(capture_thread.join, 2.0)
            if capture_thread.is_alive():
                logger.warning("Capture did not stop within two seconds; exiting daemon worker.")
        shutdown_requested = None
        event_loop = None


def shutdown_signal_handler(*_):
    logger.info("Shutdown signal received, terminating voice service...")
    stop_event.set()
    if event_loop and not event_loop.is_closed() and shutdown_requested is not None:
        event_loop.call_soon_threadsafe(shutdown_requested.set)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown_signal_handler)
    signal.signal(signal.SIGINT, shutdown_signal_handler)
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
