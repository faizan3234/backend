# RELIV Local Voice Service

Runs only on the Raspberry Pi.

## Runtime topology

PCM2902 microphone -> local VAD -> whisper.cpp server -> WebSocket -> React kiosk.

This service does not authorize payment, dispense medicine, generate reports, or change kiosk state directly.

## Pi environment

Expected microphone:
- Configured ALSA PCM: `reliv_mic` (stable card ID `RELIV_MIC`)
- PipeWire source: PCM2902 Audio Codec Analog Mono

Expected Whisper:
- /home/reliv/reliv-voice/whisper.cpp/build/bin/whisper-server
- model: ggml-base-q5_1.bin
- server: 127.0.0.1:8081

Voice WebSocket:
- ws://127.0.0.1:5100

## Daily startup: use the existing service

`node server.js` starts the kiosk API. Microphone input needs **two additional
processes**: the local Whisper recognizer and this Python voice service. The
browser plays the female guide recordings; it needs no separate speaker program.

| Part | Default local port | How it runs |
| --- | --- | --- |
| Kiosk API | 5000 | `cd ~/backend && node server.js`, only if the API is not already running. |
| Whisper recognizer | 8081 | Existing Whisper process/service, or the manual command below. |
| Microphone and WebSocket | 5100 | Existing `reliv-voice.service`. |
| Kiosk screen and recorded guides | 80 | Existing nginx deployment and kiosk browser. |

On the Pi where `reliv-voice.service` is already installed, use:

```bash
sudo systemctl restart reliv-voice.service
systemctl status reliv-voice.service --no-pager
journalctl -u reliv-voice.service -n 40 --no-pager
```

Check which processes already own the three runtime ports before launching
anything manually:

```bash
sudo ss -ltnp '( sport = :5000 or sport = :5100 or sport = :8081 )'
```

Do not also run `python voice_service.py` while the unit is active. A virtual
environment does not isolate network ports. The unit's `ExecStart` must point at
`/home/reliv/backend/voice-service/.venv/bin/python` and this service's script;
activating a venv in a terminal does not change systemd's interpreter.

If Whisper is not running, start its existing service if one is configured. To
run it manually, the following uses the binary expected by this deployment and
the model's previously used Downloads location; adjust the model path if moved:

```bash
~/reliv-voice/whisper.cpp/build/bin/whisper-server \
  -m ~/Downloads/ggml-base-q5_1.bin \
  --host 127.0.0.1 --port 8081 -l auto -t 4
```

Keep that terminal open. Use the multilingual model, without `.en` in its name,
for English/Hindi/Bengali. The service calls `/inference` on port 8081; a
microphone connection alone does not prove Whisper is running. Flags are described
in the [whisper.cpp server documentation](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md).

## Error: address already in use on port 5100

This means another process already owns the voice WebSocket address. It does not
mean PyAudio is missing. Identify the owner with the `ss` command above and check
the systemd unit. If it is the existing voice service, restart that unit rather
than starting another copy. If it is a manually started voice process, stop it
with Ctrl+C in its own terminal before switching back to the service. Do not
blindly kill an unidentified port owner or change the port to hide the conflict.

The voice program now binds the WebSocket before starting microphone capture. A
duplicate start exits with status 1 and a clear recovery message, without opening
the microphone or disturbing the existing listener. Normal shutdown stops capture
and releases the listener before exiting.

ALSA/JACK messages after the original bind traceback came from the second
process probing audio before its socket was ready. The bind guard prevents that
probe on duplicate starts. Audio warnings during a successful start still need
checking against the actual microphone status; the port fix does not diagnose
every hardware warning.

## One-time installation on Raspberry Pi OS Bookworm or newer

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
```

Then restart the existing unit using the daily-startup commands above. Keep the
Whisper server on port 8081 and the kiosk frontend open for voice recognition.

For foreground debugging only, stop the installed service first. This temporarily
pauses microphone input until the manual process starts:

```bash
sudo systemctl stop reliv-voice.service
cd ~/backend/voice-service
.venv/bin/python voice_service.py
```

If the unit has not been installed, skip the `systemctl stop` line. Any required
custom unit environment must also be set in the debugging terminal. After
debugging, press Ctrl+C and run `sudo systemctl start reliv-voice.service` to
return to the installed service.

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

Run all voice tests, including duplicate-port and shutdown regression checks:

```bash
cd ~/backend/voice-service
.venv/bin/python -m unittest discover -p 'test_voice*.py'
```
