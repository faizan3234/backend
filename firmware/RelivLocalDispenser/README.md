# Offline Reliv dispenser — standard ESP32

Use this on the **motor ESP32**, not the separate ESP32-S3 sensor board.
The sensor firmware remains on `kiosk/command` and `kiosk/sensor/*`.
No frontend change is required. Both boards use distinct MAC-derived MQTT client IDs.
Only one motor board may subscribe to this kiosk's dispense commands.

## Install

1. Deploy the backend changes in this PR and restart the backend with its normal launcher.
2. Open `RelivLocalDispenser.ino` in Arduino IDE. Select **ESP32 Dev Module** for the standard ESP32.
3. Install **PubSubClient 2.8** and **ArduinoJson 7.4.2**.
4. Copy `local_config.example.h` to `local_config.h` in the same sketch folder. Enter the existing RELIV-KIOSK Wi-Fi password. Leave MQTT credentials blank only while your local broker allows anonymous connections.
5. Verify relay polarity with motor power disconnected. The supplied circuit uses active HIGH, GPIO18/19/21, 2300ms ON and at least 2000ms OFF between units. These timings do not measure a complete mechanical revolution; calibrate them physically.
6. Upload to the motor board. Serial Monitor: 115200 baud. Internet is not required after installation.

Uploading firmware is required: merging a GitHub PR or restarting the Pi does not flash an ESP32.
Do not erase ESP flash/NVS or select an erase-all upload option: this deletes duplicate-job protection.

## Protocol and failure handling

- Pi validates payment/code first, then publishes `reliv/dispense/<jobId>` (never retained).
- JSON: `jobId, kitId, motor, quantity, timestamp`. Motors 1–3; quantity 1–10.
- The firmware queues up to eight waiting jobs and runs only one motor at a time.
- Persist the exact job and RUNNING state before energizing. A duplicate job only resends its saved result.
- After the timed cycles, publish matching identity plus SUCCESS to `reliv/dispense/confirm/<jobId>`.
- The Pi commits completion and inventory atomically, then replies on `reliv/dispense/receipt/<jobId>`.
- The ESP keeps a persistent outbox and retries its result every three seconds until that receipt arrives. Lost ACK/receipt packets do not trigger another motor run.
- On ESP reset, an unfinished RUNNING job becomes ERROR and requires staff review. It is never automatically rerun.
- Queued but unstarted commands are RAM-only: after ESP reset the Pi's existing timeout/manual-review flow handles them. Reconnect is not permission to replay motor commands.
- Full queue, invalid command, storage failure/full, corrupt journal, or identity collision refuses operation. Pi timeout exposes missing confirmations for staff review.
- The replay ledger is deliberately not auto-evicted. NVS is finite: monitor storage and reconcile/archive jobs before maintenance. This is not unlimited unattended storage.
- Backend manual retry of an old job ID does not bypass ESP replay protection. Reconcile/replace the operation under staff control; never clear all history just to retry.
- If the Pi restarted and already marked a job uncertain, a late success does not silently resolve it; staff must inspect the tray. The outbox remains pending until that exact result is recorded. Do not reset payment or charge again.

SUCCESS here means **timed motor cycles completed**, not physical delivery. ACK includes
`confirmationType: timed_motor_cycle` and `deliveryVerified: false`.
A disconnected motor or trapped packet cannot be detected with this relay-only hardware.
Use a drop sensor for physical delivery evidence.

Keep motor current off ESP GPIO/power rails. Use the relay/driver's specified supply,
flyback protection and appropriate grounding/isolation. Hardware must hold relays OFF
during reset, before firmware runs. GPIO19 can conflict with native USB on ESP32-S3;
these defaults are for the separate standard ESP32.

The firmware does not authenticate a payment itself: the backend does that. An anonymous
broker lets other Wi-Fi users publish commands. Before public use, configure broker
credentials/ACLs: backend alone publishes commands/receipts; motor alone publishes
confirmations and reads commands/receipts; sensor board uses only its sensor topics.
Do not leave old retained dispensing commands in the broker. This firmware assumes
the backend's existing non-retained command policy.

## Checks

On the Pi, observe only (this does not actuate a motor):

    mosquitto_sub -h 192.168.50.1 -p 1883 -t 'reliv/dispense/#' -v

With empty mechanisms: test all three slots, quantity two, a mixed cart, simultaneous
sensor measurements, duplicate job delivery, lost network/ACK, ESP restart mid-cycle,
and Pi restart. Expect no repeat motor operation for an old ID and staff review for
uncertain delivery. A prolonged broker outage can make remaining cart jobs time out.

Automated checks: Node ACK identity/receipt tests and native C++ motor timing, quantity,
late-loop and millis rollover tests. GitHub workflow also compiles the actual sketch
for esp32:esp32:esp32. A compile pass is not a physical relay/payment test.
No physical Pi/ESP/motor test has been performed remotely.

Library references:
- https://pubsubclient.knolleary.net/api (shared callback buffer and publish semantics)
- https://docs.espressif.com/projects/arduino-esp32/en/latest/api/preferences.html
