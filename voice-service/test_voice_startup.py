"""Exercise real socket ownership and shutdown without opening Pi hardware."""
import asyncio
from contextlib import asynccontextmanager, suppress
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import MagicMock, patch

sys.modules.setdefault("pyaudio", MagicMock())

import voice_service
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve


async def existing_owner(websocket):
    await websocket.send("existing service is still running")
    await websocket.wait_closed()


class TestVoiceStartup(unittest.IsolatedAsyncioTestCase):
    async def test_occupied_port_leaves_existing_owner_and_microphone_alone(self):
        async with serve(existing_owner, "127.0.0.1", 0) as owner:
            port = owner.sockets[0].getsockname()[1]
            with patch.object(voice_service, "HOST", "127.0.0.1"), \
                 patch.object(voice_service, "PORT", port), \
                 patch.object(voice_service, "AudioCaptureStream") as microphone, \
                 self.assertLogs("reliv_voice.main", level="ERROR") as logs:
                self.assertEqual(await voice_service.main(), 1)
                microphone.assert_not_called()
            self.assertIn("already in use", logs.output[0])
            self.assertIn("systemctl restart reliv-voice.service", logs.output[0])
            async with connect(f"ws://127.0.0.1:{port}") as websocket:
                self.assertEqual(await websocket.recv(), "existing service is still running")
        self.assertIsNone(voice_service.event_loop)

    async def test_other_startup_errors_are_not_reported_as_duplicate_processes(self):
        with patch.object(voice_service, "serve", side_effect=PermissionError(errno.EACCES, "denied")), \
             patch.object(voice_service, "AudioCaptureStream") as microphone:
            with self.assertRaises(PermissionError):
                await voice_service.main()
            microphone.assert_not_called()

    async def _exercise_shutdown(self, cancel):
        bound = {}
        started = threading.Event()
        stopped = threading.Event()
        capture_saw_listener = []

        @asynccontextmanager
        async def observed_server(*args, **kwargs):
            async with serve(*args, **kwargs) as server:
                bound["port"] = server.sockets[0].getsockname()[1]
                yield server

        def capture_worker():
            capture_saw_listener.append("port" in bound)
            started.set()
            if voice_service.stop_event.wait(5):
                stopped.set()

        with patch.object(voice_service, "HOST", "127.0.0.1"), \
             patch.object(voice_service, "PORT", 0), \
             patch.object(voice_service, "serve", side_effect=observed_server), \
             patch.object(voice_service, "capture_loop_worker", side_effect=capture_worker), \
             patch.object(voice_service, "resolve_capture_device", return_value=(None, "Test mic")):
            task = asyncio.create_task(voice_service.main())
            try:
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 3))
                self.assertEqual(capture_saw_listener, [True])
                async with connect(f"ws://127.0.0.1:{bound['port']}") as websocket:
                    self.assertEqual(json.loads(await websocket.recv())["type"], "connected")
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(task, 3)
                else:
                    voice_service.shutdown_signal_handler()
                    self.assertEqual(await asyncio.wait_for(task, 3), 0)
            finally:
                if not task.done():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task

        self.assertTrue(stopped.is_set())
        self.assertIsNone(voice_service.event_loop)
        self.assertIsNone(voice_service.shutdown_requested)
        # A subsequent start can actually bind the released port.
        async with serve(existing_owner, "127.0.0.1", bound["port"]):
            pass

    async def test_signal_shutdown_releases_capture_and_socket(self):
        await self._exercise_shutdown(cancel=False)

    async def test_cancellation_releases_capture_and_socket(self):
        await self._exercise_shutdown(cancel=True)

    async def test_duplicate_cli_exits_nonzero_without_traceback_or_audio_start(self):
        async with serve(existing_owner, "127.0.0.1", 0) as owner:
            port = owner.sockets[0].getsockname()[1]
            runner = """
import runpy, sys
from unittest.mock import MagicMock
audio = MagicMock()
audio.PyAudio.side_effect = AssertionError('UNEXPECTED_MIC_OPEN')
sys.modules['pyaudio'] = audio
runpy.run_path('voice_service.py', run_name='__main__')
"""
            result = await asyncio.to_thread(
                subprocess.run, [sys.executable, "-c", runner],
                cwd=Path(__file__).parent,
                env={**os.environ, "RELIV_VOICE_HOST": "127.0.0.1", "RELIV_VOICE_PORT": str(port)},
                capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("already in use", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("UNEXPECTED_MIC_OPEN", result.stderr)


if __name__ == "__main__":
    unittest.main()
