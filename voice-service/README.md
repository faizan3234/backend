# RELIV Local Voice Service

Runs only on the Raspberry Pi.

## Runtime topology

PCM2902 microphone -> local VAD -> whisper.cpp server -> WebSocket -> React kiosk.

This service does not authorize payment, dispense medicine, generate reports, or change kiosk state directly.

## Pi environment

Expected microphone:
- ALSA: plughw:3,0
- PipeWire source: PCM2902 Audio Codec Analog Mono

Expected Whisper:
- /home/reliv/reliv-voice/whisper.cpp/build/bin/whisper-server
- model: ggml-base-q5_1.bin
- server: 127.0.0.1:8081

Voice WebSocket:
- ws://127.0.0.1:5100

## Install and start on Raspberry Pi OS Bookworm or newer

Run these commands on the Pi. The system Python supplies the prebuilt PyAudio
package; the virtual environment installs the remaining Python dependencies.
Using `--system-site-packages` makes the apt-installed PyAudio visible inside it.

```bash
cd ~/backend/voice-service
sudo apt update
sudo apt install -y python3-pyaudio python3-venv
/usr/bin/python3 -m venv --system-site-packages .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -c "import pyaudio, requests; from websockets.asyncio.server import serve; print('Voice dependencies OK')"
python voice_service.py
```

Keep the Whisper server running on port 8081 and the kiosk frontend open for
voice recognition. Run only one copy of the voice service.

For later starts, activate this environment before launching the service:

```bash
cd ~/backend/voice-service
source .venv/bin/activate
python voice_service.py
```

If `ModuleNotFoundError: No module named 'pyaudio'` appears, repeat the installation
commands and run the dependency check in the same environment used to start the
service. The unit tests mock PyAudio and do not verify the microphone or its
installation on the Pi.

For an isolated environment without system packages, install `portaudio19-dev`,
`python3-dev`, and `build-essential` with apt before installing `requirements.txt`;
pip needs those headers and tools to build PyAudio on Linux.

## Important

RELIV_ALLOW_BARGE_IN defaults to 0 until PipeWire echo cancellation is configured.
Without AEC, the kiosk speaker can retrigger the microphone.
