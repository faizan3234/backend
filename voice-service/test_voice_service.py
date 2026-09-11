"""
Automated unit tests for RELIV voice service modules.
Verifies VAD logic, DialogueBridge protocol formatting/parsing, EchoController suppression,
and SpeechSessionState concurrency.
"""
import unittest
import sys
from unittest.mock import MagicMock, patch
sys.modules['pyaudio'] = MagicMock()

import config
from aec import EchoController
from dialogue_bridge import DialogueBridge
from speech_session import SpeechSessionState
from vad import VoiceActivityDetector, compute_frame_rms


class TestVAD(unittest.TestCase):
    def test_silence_rms(self):
        silence = b"\x00" * 640
        self.assertEqual(compute_frame_rms(silence), 0.0)

    def test_vad_speech_start_and_end(self):
        vad = VoiceActivityDetector(
            threshold_rms=500,
            start_frames=2,
            end_silence_ms=40,  # 2 frames of 20ms
            min_speech_ms=20,   # 1 frame
            preroll_ms=40,
        )

        silence_frame = b"\x00" * 640
        # Loud frame (alternating 2000 and -2000)
        loud_samples = [2000, -2000] * 160
        loud_frame = b"".join(s.to_bytes(2, byteorder="little", signed=True) for s in loud_samples)

        # 1. Feed silence -> no transition
        event, level, _ = vad.process_frame(silence_frame)
        self.assertIsNone(event)

        # 2. Feed loud frame 1 -> no transition yet (needs 2 start frames)
        event, level, _ = vad.process_frame(loud_frame)
        self.assertIsNone(event)

        # 3. Feed loud frame 2 -> SPEECH_STARTED triggered
        event, level, _ = vad.process_frame(loud_frame)
        self.assertEqual(event, "SPEECH_STARTED")
        self.assertTrue(vad.active)

        # 4. Feed loud frame 3 -> continuing active speech
        event, level, _ = vad.process_frame(loud_frame)
        self.assertIsNone(event)

        # 5. Feed silence frame 1 -> silence counting
        event, level, _ = vad.process_frame(silence_frame)
        self.assertIsNone(event)

        # 6. Feed silence frame 2 -> reaches end_silence threshold -> SPEECH_ENDED
        event, level, completed = vad.process_frame(silence_frame)
        self.assertEqual(event, "SPEECH_ENDED")
        self.assertIsNotNone(completed)
        self.assertFalse(vad.active)


class TestDialogueBridge(unittest.TestCase):
    def test_parse_set_context(self):
        msg = {
            "type": "set_context",
            "page": "CUSTOMER_DETAILS",
            "expecting": "gender",
            "vocabulary_hints": ["male", "female", "other"],
        }
        action, data = DialogueBridge.parse_client_message(msg)
        self.assertEqual(action, "SET_CONTEXT")
        self.assertEqual(data["page"], "CUSTOMER_DETAILS")
        self.assertEqual(data["expecting"], "gender")
        self.assertEqual(data["vocabulary_hints"], ["male", "female", "other"])

    def test_parse_reliv_speaking(self):
        msg = {"type": "reliv_speaking", "active": True}
        action, data = DialogueBridge.parse_client_message(msg)
        self.assertEqual(action, "SET_RELIV_SPEAKING")
        self.assertTrue(data["active"])

    def test_actual_frontend_speaker_message(self):
        for active in (True, False):
            action, data = DialogueBridge.parse_client_message({"type": "SET_RELIV_SPEAKING", "active": active})
            self.assertEqual(action, "SET_RELIV_SPEAKING")
            self.assertEqual(data["active"], active)

    def test_partial_context_does_not_erase_question(self):
        action, data = DialogueBridge.parse_client_message({"type": "SET_CONTEXT", "page": "/customer-details"})
        session = SpeechSessionState()
        session.update_context(page="/customer-details", expecting="gender", hints=["female"])
        session.update_context(page=data["page"], expecting=data["expecting"], hints=data["vocabulary_hints"])
        self.assertEqual(session.get_snapshot()["expecting"], "gender")
        self.assertEqual(session.get_snapshot()["vocabulary_hints"], ["female"])

    def test_non_object_message_is_ignored(self):
        for value in (None, [], 12, "text"):
            self.assertEqual(DialogueBridge.parse_client_message(value)[0], "UNKNOWN")

    def test_parse_set_language(self):
        msg = {"type": "set_language", "language": "hi"}
        action, data = DialogueBridge.parse_client_message(msg)
        self.assertEqual(action, "SET_LANGUAGE")
        self.assertEqual(data["language"], "hi")

    def test_make_transcript_event(self):
        evt = DialogueBridge.make_transcript_event("mera naam Faizan hai", language="hi", confidence=0.91, is_final=True)
        self.assertEqual(evt["type"], "transcript")
        self.assertEqual(evt["text"], "mera naam Faizan hai")
        self.assertEqual(evt["language"], "hi")
        self.assertEqual(evt["confidence"], 0.91)
        self.assertTrue(evt["is_final"])


class TestEchoController(unittest.TestCase):
    def test_suppression(self):
        aec = EchoController(allow_barge_in=False)
        self.assertFalse(aec.should_suppress_mic())

        aec.set_reliv_speaking("client1", True)
        self.assertTrue(aec.should_suppress_mic())

        aec.set_reliv_speaking("client1", False)
        import time; time.sleep(0.26)
        self.assertFalse(aec.should_suppress_mic())

    def test_barge_in_allowed(self):
        aec = EchoController(allow_barge_in=True)
        aec.set_reliv_speaking("client1", True)
        self.assertFalse(aec.should_suppress_mic())

    def test_multiple_clients(self):
        aec = EchoController(allow_barge_in=False)
        aec.set_reliv_speaking("client1", True)
        aec.set_reliv_speaking("client2", True)
        self.assertTrue(aec.should_suppress_mic())

        aec.set_reliv_speaking("client1", False)
        # Still suppressed because client2 is speaking
        self.assertTrue(aec.should_suppress_mic())

        aec.remove_client("client2")
        # Now both are gone, wait for guard
        import time; time.sleep(0.26)
        self.assertFalse(aec.should_suppress_mic())

    def test_concurrent_clients(self):
        import threading
        import time
        aec = EchoController(allow_barge_in=False)
        
        def client_worker(client_id):
            aec.set_reliv_speaking(client_id, True)
            time.sleep(0.01)
            aec.should_suppress_mic()
            time.sleep(0.01)
            aec.set_reliv_speaking(client_id, False)

        threads = [threading.Thread(target=client_worker, args=(f"client_{i}",)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
            
        import time; time.sleep(0.26)
        self.assertFalse(aec.should_suppress_mic())

    def test_suppression_guard(self):
        import time
        aec = EchoController(allow_barge_in=False)
        aec.set_reliv_speaking("client1", True)
        self.assertTrue(aec.should_suppress_mic())
        aec.set_reliv_speaking("client1", False)
        # Should still be true due to guard
        self.assertTrue(aec.should_suppress_mic())
        # wait 0.25
        time.sleep(0.26)
        self.assertFalse(aec.should_suppress_mic())


class TestSpeechSession(unittest.TestCase):
    def test_session_state(self):
        # A. new session: is_paused == False
        session = SpeechSessionState()
        self.assertFalse(session.is_paused())

        session.update_context(page="PAYMENT", expecting="code", hints=["one", "two"])
        snap = session.get_snapshot()
        self.assertEqual(snap["page"], "PAYMENT")
        self.assertEqual(snap["expecting"], "code")
        self.assertEqual(snap["vocabulary_hints"], ["one", "two"])

        # B. PAUSE_LISTENING: is_paused == True
        session.set_listening_paused(True)
        self.assertTrue(session.is_paused())

        # C. force_resume: is_paused == False
        session.force_resume()
        self.assertFalse(session.is_paused())
        
    def test_locale_normalization(self):
        session = SpeechSessionState()
        session.set_language("en-gb")
        self.assertEqual(session.language, "en")
        session.set_language("hi-in")
        self.assertEqual(session.language, "hi")
        session.set_language("bn-in")
        self.assertEqual(session.language, "bn")
        session.set_language("unknown")
        self.assertEqual(session.language, "auto")
        
    def test_generation(self):
        session = SpeechSessionState()
        self.assertEqual(session.get_generation(), 0)
        session.increment_generation()
        self.assertEqual(session.get_generation(), 1)

    def test_only_context_changes_invalidate_transcripts(self):
        session = SpeechSessionState()
        session.update_context(page="/customer-details", expecting="name", hints=["name"])
        generation = session.get_generation()
        session.update_context(page="/customer-details", expecting="name", hints=["name"])
        self.assertEqual(session.get_generation(), generation)
        session.update_context(expecting="confirm")
        self.assertGreater(session.get_generation(), generation)
        session.update_context(page="/two-options")
        self.assertEqual(session.get_snapshot()["expecting"], "")
        self.assertEqual(session.get_snapshot()["vocabulary_hints"], [])

    def test_pause_and_reconnect_invalidate_transcripts(self):
        session = SpeechSessionState()
        session.set_listening_paused(True)
        self.assertEqual(session.get_generation(), 1)
        session.force_resume()
        self.assertEqual(session.get_generation(), 2)


class TestVADDynamic(unittest.TestCase):
    def test_dynamic_endpointing(self):
        vad = VoiceActivityDetector()
        vad.update_context("confirmation")
        self.assertEqual(vad.silence_frames_to_end, max(1, 220 // config.FRAME_MS))
        vad.update_context("name")
        self.assertEqual(vad.silence_frames_to_end, max(1, 350 // config.FRAME_MS))
        vad.update_context("unknown")
        self.assertEqual(vad.silence_frames_to_end, max(1, 400 // config.FRAME_MS))


class TestConfigDefaults(unittest.TestCase):
    def test_vad_defaults(self):
        # G. VAD end default == 0.45
        self.assertEqual(config.VAD_END_SILENCE_MS, 450)
        # H. VAD start default == 0.06
        self.assertEqual(config.VAD_START_FRAMES, 3)
        # I. VAD min default == 0.15
        self.assertEqual(config.VAD_MIN_SPEECH_MS, 150)

    def test_barge_in_default(self):
        # F. RELIV_ALLOW_BARGE_IN=0 => ALLOW_BARGE_IN False
        self.assertFalse(config.ALLOW_BARGE_IN)

class TestHallucinationFilter(unittest.TestCase):
    def test_repetitive_hallucination_rejected(self):
        import voice_service
        text = "I'm not going to be a doctor. " * 20
        self.assertTrue(voice_service.is_pathological_transcript(text))

    def test_normal_phrases_accepted(self):
        import voice_service
        self.assertFalse(voice_service.is_pathological_transcript("health checkup"))
        self.assertFalse(voice_service.is_pathological_transcript("Faizan Khan"))
        self.assertFalse(voice_service.is_pathological_transcript("43 years"))
        self.assertFalse(voice_service.is_pathological_transcript("I want to check my health today and then go home."))

class TestTranscriptionBusy(unittest.TestCase):
    def test_busy_flag_flow(self):
        import voice_service
        voice_service.transcription_busy.set()
        self.assertTrue(voice_service.transcription_busy.is_set())
        
        # Test worker clears it
        with patch.object(voice_service.whisper_client, 'transcribe', return_value=("", 0, "auto")):
            voice_service.async_transcribe_worker(frames=[], started_at=0.0, original_generation=voice_service.session_state.get_generation())
        self.assertFalse(voice_service.transcription_busy.is_set())


class MockWebSocket:
    def __init__(self, messages=None):
        self.messages = messages or []
        self.sent_messages = []
        self._closed = False
    async def send(self, data):
        self.sent_messages.append(data)
    async def close(self):
        self._closed = True
    def __aiter__(self):
        self.iter = iter(self.messages)
        return self
    async def __anext__(self):
        try:
            return next(self.iter)
        except StopIteration:
            raise StopAsyncIteration

class TestVoiceServiceLogic(unittest.IsolatedAsyncioTestCase):
    async def test_handshake_flow(self):
        import json
        import voice_service
        voice_service.active_controller_ws = None
        voice_service.active_controller_id = None
        
        # Test basic connection with CLIENT_HELLO
        ws1 = MockWebSocket([json.dumps({"type": "client_hello", "clientId": "c1", "role": "kiosk-controller"})])
        await voice_service.ws_handler(ws1)
        self.assertEqual(voice_service.active_controller_id, None) # It gets cleared in finally block of ws_handler because iterator finishes and it disconnects!
        
        # It's difficult to assert internal state while running, so let's verify sent messages
        connected_events = [json.loads(m) for m in ws1.sent_messages if "type" in m and json.loads(m)["type"] == "connected"]
        self.assertEqual(len(connected_events), 1)
        
        active_events = [json.loads(m) for m in ws1.sent_messages if "type" in m and json.loads(m)["type"] == "CONTROLLER_ACTIVE"]
        self.assertEqual(len(active_events), 1)


class TestWhisperLocalOnly(unittest.TestCase):
    def test_auto_language_and_detected_language(self):
        import whisper_asr
        from speech_session import write_frames_to_temp_wav, safe_delete_file
        path = write_frames_to_temp_wav([b"\x00" * 640])
        try:
            response = MagicMock()
            response.json.return_value = {"text": "चालीस साल", "language": "hindi"}
            with patch.object(whisper_asr.requests, "post", return_value=response) as post:
                text, confidence, language = whisper_asr.WhisperClient().transcribe(path, language="auto", vocabulary_hints=["age"])
                self.assertEqual(text, "चालीस साल")
                self.assertEqual(language, "hi")
                self.assertEqual(post.call_args.kwargs["data"]["language"], "auto")
                self.assertIn("age", post.call_args.kwargs["data"]["prompt"])
        finally:
            safe_delete_file(path)

    def test_connection_failure_never_uses_cloud_fallback(self):
        import whisper_asr
        from speech_session import write_frames_to_temp_wav, safe_delete_file
        path = write_frames_to_temp_wav([b"\x00" * 640])
        try:
            with patch.object(whisper_asr.requests, "post", side_effect=whisper_asr.requests.ConnectionError("offline")) as post:
                self.assertEqual(whisper_asr.WhisperClient().transcribe(path), ("", 0.0, "auto"))
                self.assertEqual(post.call_count, 1)
        finally:
            safe_delete_file(path)

    def test_worker_uses_auto_and_drops_answer_after_context_changes(self):
        import voice_service
        state = SpeechSessionState()
        state.update_context(page="/customer-details", expecting="name")
        generation = state.get_generation()

        def transcribe(**kwargs):
            self.assertEqual(kwargs["language"], "auto")
            state.update_context(page="/two-options", expecting="service")
            return ("Faizan Khan", 0.9, "en")

        with patch.object(voice_service, "session_state", state), \
             patch.object(voice_service.whisper_client, "transcribe", side_effect=transcribe), \
             patch.object(voice_service, "broadcast_threadsafe") as send:
            voice_service.async_transcribe_worker([b"\x00" * 640], 0, generation)
            send.assert_not_called()
            self.assertFalse(voice_service.transcription_busy.is_set())


class TestRealWebSocketProtocol(unittest.IsolatedAsyncioTestCase):
    async def test_actual_handshake_speaker_gate_context_and_reconnect(self):
        import json
        import voice_service
        from websockets.asyncio.server import serve
        from websockets.asyncio.client import connect

        state = SpeechSessionState()
        echo = EchoController(allow_barge_in=False)
        with patch.object(voice_service, "session_state", state), \
             patch.object(voice_service, "echo_controller", echo), \
             patch.object(voice_service, "resolve_capture_device", return_value=(None, "test microphone")):
            async with serve(voice_service.ws_handler, "127.0.0.1", 0) as server:
                port = server.sockets[0].getsockname()[1]
                async with connect(f"ws://127.0.0.1:{port}") as socket:
                    self.assertEqual(json.loads(await socket.recv())["type"], "connected")
                    await socket.send(json.dumps({"type": "CLIENT_HELLO", "clientId": "test-controller", "role": "kiosk-controller"}))
                    self.assertEqual(json.loads(await socket.recv())["type"], "CONTROLLER_ACTIVE")
                    await socket.send(json.dumps({"type": "SET_RELIV_SPEAKING", "active": True}))
                    await socket.send(json.dumps({"type": "SET_CONTEXT", "page": "/customer-details", "expecting": "gender", "vocabulary_hints": ["female"]}))
                    await socket.send(json.dumps({"type": "PING"}))
                    self.assertEqual(json.loads(await socket.recv())["type"], "pong")
                    self.assertTrue(echo.should_suppress_mic())
                    self.assertEqual(state.get_snapshot()["expecting"], "gender")
                    await socket.send(json.dumps({"type": "SET_RELIV_SPEAKING", "active": False}))
                    await socket.send(json.dumps({"type": "PAUSE_LISTENING"}))
                    await socket.send(json.dumps({"type": "PING"}))
                    await socket.recv()
                    self.assertTrue(state.is_paused())
                    self.assertTrue(echo.should_suppress_mic())
                async with connect(f"ws://127.0.0.1:{port}") as socket:
                    await socket.recv()
                    await socket.send(json.dumps({"type": "CLIENT_HELLO", "clientId": "test-controller", "role": "kiosk-controller"}))
                    self.assertEqual(json.loads(await socket.recv())["type"], "CONTROLLER_ACTIVE")
                    self.assertFalse(state.is_paused())


if __name__ == "__main__":
    unittest.main()
