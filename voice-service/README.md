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

## Help and payment guidance mode

The kiosk uses touch for names, ages, gender, language, service choices, and codes.
The mic only requests instructions (English/Hindi/Bengali) or answers the payment
question while the payment QR is ready. A spoken yes opens code entry; only the
existing payment API can authorize a transaction.

The frontend sends `expecting=help` normally and `payment_confirmation` while
accepting payment replies. Endpointing uses 350 ms and 220 ms of trailing silence,
respectively; these are not promises of total Whisper processing latency. Audio
capture stays open, while speaker gating discards frames during kiosk speech and
its acoustic tail. Keep `RELIV_ALLOW_BARGE_IN=0` on this deployment.

Capture prefers the configured `reliv_mic` PCM when PortAudio exposes it, then a
valid default input, then a physical microphone. Monitor/loopback inputs are
rejected. This preserves the Pi's configured ALSA conversion and supports native
44.1/48 kHz inputs with software resampling when necessary. A device-discovery
failure or unplug retries without terminating the capture thread.

The code does not modify `/etc/asound.conf`, udev rules, ALSA mixer settings,
PipeWire, Python packages, or `reliv-voice.service`. The global ALSA `pcm.!default`
can affect playback as well as recording. ALSA `plug` converts formats/rates; it
is not echo cancellation. See the [ALSA plug documentation](https://www.alsa-project.org/alsa-doc/alsa-lib/pcm_plugins.html).

After deploying this branch, restart the existing service and inspect it:

```bash
sudo systemctl restart reliv-voice.service
systemctl status reliv-voice.service --no-pager
journalctl -u reliv-voice.service -n 40 --no-pager
```

Its `ExecStart` must use the voice-service virtual environment's Python. Do not
run a second `python voice_service.py` process while the service is active.
The unit tests mock audio hardware; perform the physical checks described in the
frontend's `docs/VOICE_GUIDANCE.md` before marking a kiosk deployment verified.
