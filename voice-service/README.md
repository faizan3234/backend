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

## Important

RELIV_ALLOW_BARGE_IN defaults to 0 until PipeWire echo cancellation is configured.
Without AEC, the kiosk speaker can retrigger the microphone.