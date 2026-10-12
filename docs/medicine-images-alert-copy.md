# Medicine image proxy and readable stock alerts

Serve the existing medicine image directory under both /medicine-images and /api/medicine-images. This preserves stored file paths and supports nginx installations that proxy only /api. No existing image files, database, credentials or payment keys are moved or changed.

Operations emails identify the medicine, kiosk, last recorded number left and unit price. Zero gets a clear out-of-stock subject. A short explanation says the count was taken before dispensing and may now be lower. This must not be described as confirmed post-dispense stock: the offline Pi cannot send a newer value without another transfer.

Existing payment verification, signed snapshot checks, deduplication and durable retry worker remain unchanged. Emails are from the configured Reliv operations mailbox to the fixed administrator, never from a customer's mailbox. Real SMTP credentials are required on Oracle.

Validation: node --check server.js; 33 kiosk checks including real HTTP retrieval of identical bytes through both medicine image routes and missing-image 404; 13 stock alert tests including zero stock, low stock, unpaid rejection, duplicates and failure recovery. No real email or medicine was sent/dispensed.

Dispenser diagnosis: Pi publishes reliv/dispense/<jobId> with jobId, kitId, motor and quantity. The dispenser must acknowledge on reliv/dispense/confirm/<jobId> with the matching jobId, kitId and quantity after actual completed delivery. Progress acknowledgements are not completion. Missing/ambiguous delivery must go to staff review, never automatic redispatch of an in-progress job. The motor firmware is not present in this repository, so its physical behavior remains unverified.

Consolidates the missing-ACK handling from backend #43: status checks move overdue IN_PROGRESS jobs to durable MANUAL_REVIEW_REQUIRED after max(90, 30 + quantity*30) seconds. No automatic redispatch or acceptance of late ACKs after staff-review state. Status now includes delivered quantities, separately from item-type/job counts. Use #44 rather than also merging #43.
