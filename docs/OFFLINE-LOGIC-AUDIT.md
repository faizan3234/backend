# Offline logic audit — 27 October 2026

Companion frontend: https://github.com/faizan3234/reliv-frontend/pull/81
Backend: https://github.com/faizan3234/backend/pull/52

## Problems fixed, in plain language

| Before | Example | Fix |
|---|---|---|
| One medicine could appear twice in the cart, but the motor accepts one job per medicine. | Rahul adds the same kit through two cart entries. Payment covers both; activation can fail. | Merge duplicate item IDs before pricing and payment; reject invalid quantities rather than quietly rounding them. |
| The browser could sell quantities the firmware cannot finish within its queue window. | A very large order pays, then an unstarted motor job expires. | Limit the complete order to ten units, including all medicines. The frontend explains the limit; the backend enforces it. Pricing rates/fees are unchanged. |
| Physical stock was used for a new quote even when some units were reserved. | Two units are on the shelf; one belongs to a pending dispense. Another customer requests both. | Only unreserved stock is available for a new quote. |
| Admin edits accepted fractional stock, clamped negative stock to zero, or changed a slot referenced by an unfinished order. | A staff member enters 1.5 units or changes the medicine in a slot after someone receives a QR. | Require whole numbers; reject reductions below reserved stock and reject renaming/moving slots with unresolved orders. Historical items cannot be deleted; staff can set unreserved stock to zero. |
| A stock inconsistency could be hidden by clamping subtraction to zero. | The database says one unit, but an ACK tries to deduct two. | Fail and roll back the stock transaction for staff review, rather than pretending accounting balanced. |
| Startup silently deleted duplicate legacy dispense records. | One record proves a motor ran; another says pending. Deleting the wrong row loses the evidence. | Preserve every row, quarantine unfinished duplicates, and block dispatch for that transaction/item until reviewed. Startup can still serve other kiosk functions. |
| Finalization did not explicitly check that the payment transaction belonged to the supplied session. | A programming mistake passes Rahul's payment with Raj's session. | Reject the mismatch before mutating payment/session state. |
| Offline feedback could be acknowledged without being stored anywhere. | Raj submits a complaint while Pi email is unconfigured. | Save in local SQLite first. Admin can view paginated feedback. A retry with the same reference makes no duplicate row or notification. Optional mail does not delay the local save. |
| Duplicate MongoDB inventory handlers remained below the SQLite routes. | A future developer edits the wrong unreachable handler. | Remove the shadowed inventory routes; SQLite remains the inventory authority. |

## Inventory email: what is already correct, and what offline cannot prove

The cloud bridge already queues/checks low-stock alerts immediately after server-verified payment. It also has a durable retry worker. A customer does **not** have to request their own email receipt first. Tests cover signed snapshots at 2, 1 and 0 and notification retry/deduplication. No live email was sent in this audit.

The stock snapshot travels in the QR **before dispensing**. If it says 3 before payment and the motor later reduces it to 2, the Internet-isolated Pi cannot instantly notify Oracle of that new count without a later phone transfer or another connection. Do not label the old snapshot as live stock or delivery proof. Existing signed-snapshot wording and local support evidence remain authoritative about this limitation.

Motor-cycle completion is not proof that a packet dropped. A jam, removed wire, power loss or unacknowledged command still requires staff review. No automatic replay or invented delivery confirmation was added.

## Validation and remaining release checks

Regression coverage includes cart aggregation and limits, reservation-protected stock edits, unchanged pricing math, cross-session rejection, feedback restart persistence/idempotency, preserved duplicate evidence, payment replay/expiry, ads, bridge alerts, local health and dispensing ACK/receipt behavior. Synthetic keys/databases are used in isolated test environments; production secrets are not included.

This is a targeted source audit with regression verification, not a guarantee of zero future defects or certification of every hardware/network combination. Raspberry Pi, motor/drop sensors, Gmail delivery, Razorpay live capture and physical speakers were not tested here.

Before rollout, keep a SQLite backup, stage both PRs, and on the actual kiosk:

1. Finish a medicine visit, return home, then start another: the cart must be empty.
2. Submit feedback with Pi Internet disconnected; refresh `/admin` and confirm exactly one entry after a retry.
3. Use an authorized paid order with staff watching the tray. Confirm one stock deduction and one motor operation per job. A missing/uncertain ACK must remain reviewable, never auto-vend again.
4. On the Oracle bridge, confirm configured Reliv SMTP sends an alert for a paid QR carrying stock 2, 1 or 0 without requesting a customer receipt. This checks email delivery, not a post-dispense stock update.
5. Verify actual Hindi/Bengali/English sound and touch scrolling at 1280×800. Software mocks cannot validate speakers, Pi GPU/video performance or your exact browser.

Deploy the backend before the frontend so the new local feedback viewer endpoint is available. Do not copy test keys into the Pi or Oracle configuration.
