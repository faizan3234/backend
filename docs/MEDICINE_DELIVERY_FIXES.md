# Medicine delivery follow-up

Deploy this backend on the Pi before the companion frontend. Keep the existing SQLite database and MEDICINE_IMAGE_DIR. Existing uploaded photos can now be read at both /medicine-images/<filename> and /api/medicine-images/<filename>. The latter uses the existing nginx API proxy and avoids a kiosk HTML response instead of an image. Missing files return 404 rather than falling through to the kiosk page.

Dispensing jobs that got a broker PUBACK but never got an ESP32 delivery ACK previously remained IN_PROGRESS indefinitely. Status polling now moves overdue jobs to MANUAL_REVIEW_REQUIRED after max(90, 30 + quantity*30) seconds from publishing. It never republishes an uncertain command or marks an item delivered. Completed jobs remain completed; pending unpublished jobs are not mistaken for delivered items. This is a bounded failure path, not a replacement for working motor feedback.

The only ESP32 sketch in this repository is RelivLocalSensors, which measures sensors. It does not subscribe to dispense commands or confirm a physical drop. The installed dispenser sketch/wiring is not available here, so physical delivery cannot be certified or safely implemented by inventing pins. The existing contract is:

- Pi publishes reliv/dispense/<jobId>, payload {jobId, kitId, motor, quantity, timestamp}.
- Dispenser publishes reliv/dispense/confirm/<jobId> with matching {jobId, kitId, motor, quantity, status:"SUCCESS"} only after its physical delivery check.
- Command receipt alone is not SUCCESS. Firmware must suppress duplicate job IDs durably before motion and report failures without rerunning uncertain orders.

On the Pi, during a normal paid order, observe without sending any commands:

```bash
mosquitto_sub -h 192.168.50.1 -p 1883 -v -t 'reliv/dispense/#'
```

A command with no matching final confirmation explains 0/1. Share the actual dispenser Arduino sketch to complete firmware integration. Do not publish a synthetic SUCCESS on a real paid order, or retry motors before checking the tray.

After updating both sides, open admin and the catalog and check an existing photo. Complete one controlled paid order and verify the command and real ACK, item count, stock deduction, and collection screen. Actual motor operation and phone camera speed were not tested here.

The Oracle payment bridge stock email now names the item, last recorded quantity, price and kiosk in everyday language. It explicitly says the count was taken before this customer's dispensing and may now be lower. An offline Pi cannot provide a new live post-dispense stock count to Oracle through a QR that was created earlier. Deploy payment-bridge-service on Oracle for the revised email text; no payment keys change.

Automated checks: actual Express static image routes (legacy/API, missing/traversal), strict dispense ACK validation, missing-ACK timeout, duplicate suppression and item counts; low-stock email deduplication and failure handling. No real email or dispense was triggered.
