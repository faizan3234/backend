# Offline spoken reports and confirmed medicine collection

Deploy the companion backend patch before this frontend, then restart the
manually running backend (`npm start`) and rebuild/deploy the frontend.

## Speech

Every report route uses the current unified report with a spoken summary of real
measurements, Listen/Stop controls and visible text. English, Hindi and Bengali
are identified by their names, never national flags. Missing readings are spoken
as missing. Topic buttons keep their explanation on screen even if audio fails.

Recorded audio remains supported. Dynamic speech uses an installed local browser
voice for the selected language; if unavailable, the browser posts to the Pi's
`/api/speech/audio`. The Pi uses espeak-ng to generate WAV in memory and sends it
back for browser playback. There are no cloud TTS requests, saved report-audio
files or shell interpolation. Speech is limited to 1600 characters per request,
two simultaneous conversions, 15-second synthesis timeout and 8 MiB output.
Cancellation drops late responses, stops audio and releases blob URLs. Browser
playback owns the microphone gate. The Python recognizer no longer speaks its
own response over the frontend. Automatic playback may need a tap on Listen.

Install espeak-ng and its voice data on the Pi before taking it offline. If the Pi
has no internet, download compatible Raspberry Pi OS packages and dependencies
on a connected machine and transfer them; an online apt command will not work
on a disconnected Pi. Do not replace payment keys or database files.

On the Pi check:

```bash
command -v espeak-ng
espeak-ng --voices=en
espeak-ng --voices=hi
espeak-ng --voices=bn
aplay -l
```

After starting the backend, test a non-private phrase locally:

```bash
curl --fail --max-time 20 http://127.0.0.1:5000/api/speech/audio \
  -H 'Content-Type: application/json' \
  -d '{"language":"bn","text":"রিলিভে স্বাগতম।"}' \
  -o /tmp/reliv-speaker-test.wav
aplay /tmp/reliv-speaker-test.wav
```

Finally use Chromium with speakers attached: open a paid report, tap Listen,
change each language, adjust volume, Stop, navigate away during speech and verify
that no old narration returns. Browser volume and OS output device/mute are
separate. If the service/voice/speaker is missing the UI shows an actionable
message; software tests cannot prove audible output on your real hardware.
Offline microphone questions still require the existing local Whisper/voice
service and downloaded models. Topic buttons work without microphone setup.

## Medicine flow

Catalog and checkout offer spoken instructions. Unsupported purchase counters,
invented MRP and timed claims of email/UV completion have been removed. A failed
inventory refresh keeps the customer on the catalog with retry guidance.

The collection screen performs read-only polling of
`GET /api/sessions/:sessionId/status`; it never publishes MQTT or creates another
payment/dispense request. Only a matching paid medicine session with positive
job count and all jobs confirmed allows the collection button. Partial delivery,
missing session, disconnection and manual review get distinct guidance in all
three languages. There is no countdown that pretends delivery succeeded.

Backend uses SQLite job state and local MQTT:

- Pi -> ESP32: `reliv/dispense/<jobId>`, QoS 1, not retained.
  JSON: `{ "jobId":"...", "kitId":"...", "motor":1, "quantity":1, "timestamp":... }`.
- ESP32 -> Pi: `reliv/dispense/confirm/<jobId>`, not retained.
  JSON after actual delivery: `{ "jobId":"...", "kitId":"...", "motor":1, "quantity":1, "status":"SUCCESS" }`.
- Failure must use `status:"FAILED"` or `success:false`; the Pi freezes the job
  for staff review. Acknowledging receipt of a command is NOT a delivery ACK.

The backend persists IN_PROGRESS before publishing. Duplicate starts cannot
publish twice; an early device ACK is not overwritten by MQTT publish completion.
An uncertain send or physical failure requires staff review, not automatic retry.
After a restart, in-progress jobs remain subject to the existing review recovery.

The actual dispenser firmware was not supplied. The earlier sensor ESP32 sketch
only reads sensors and cannot drive a motor or prove an item dropped. Do not
connect motors to invented pins. To finish firmware integration provide the motor
controller sketch, exact board/driver wiring and drop/position sensor details.
The dispenser must durably remember job IDs before motion, suppress MQTT QoS1
redelivery, and emit SUCCESS only after the configured physical delivery check.
No new motor actuation firmware or successful physical dispense is claimed here.

The currently anonymous kiosk MQTT listener does not authenticate the physical
source of messages. Restrict dispenser command/ACK topics with separate device
credentials/ACLs before relying on them against untrusted hotspot clients; the
frontend's sensor connection and dispensing-controller permissions are distinct.
Do not publish synthetic motor commands or success ACKs on the production kiosk.

Payment remains verified by the existing payment bridge/activation flow; local
fulfillment itself does not require the Pi to access the internet.

## Verification scope

Automated tests cover translated narration, missing readings, local WAV process
input/error/cancellation, no cloud fallback, audible-playback API lifecycle,
status polling, partial ACK, final ACK, uncertain state, durable pre-publish claim
and duplicate starts. Physical audio, GPIO/motors, sensors, calibration and actual
Pi Chromium remain on-site acceptance checks.
