# Inventory/payment audit — 5 November 2026

## Completed in this change
- [x] Trace admin stock emails: verified-payment and recovery paths trigger them independently of customer receipt requests; durable Oracle worker retries known send failures.
- [x] Fix missed threshold crossing: signed QR now includes purchased items that will leave at most two units (including 3 minus 1).
- [x] Preserve physical quantity separately from purchased quantity; email labels the remainder as expected, never sensor-confirmed delivery.
- [x] Prioritize purchased items before unrelated low-stock telemetry when fitting the QR.
- [x] Deduplicate each paid order's projection while retaining existing snapshot deduplication for legacy QRs.
- [x] Review frontend MedicineDispensing: available quantity excludes reservations; stock refreshes and checkout rechecks; zero available disables selection.
- [x] Regression checks: 18 stock/revision/atomic tests, 24 cart-lifecycle assertions, 8 QR-capacity tests passed locally.

## Remaining gates — not claimed complete
- [ ] Full frontend/backend audit and responsive visual testing of all screens.
- [ ] Actual Oracle SMTP configuration and inbox delivery, without a customer receipt request.
- [ ] Physical Pi payment → reservation → motor → stock deduction, including network loss and power failure.
- [ ] Real post-dispense cloud telemetry: an offline Pi needs another communication path to report its final physical state.

## Installation order and limitations
Deploy the Oracle bridge first, then the Pi backend. New signed stock projections may contain a physical quantity above two; an older bridge rejects those. Existing QRs without purchasedQuantity stay supported. Generate a fresh payment QR after updating the Pi. No frontend update is required for this change.

Example: one Paracetamol left, customer pays for one and skips receipt email. Oracle independently attempts an admin alert: paid order 1, expected remainder 0, refill before further sales. It does not wait for a second customer. The Pi reserves the item so another customer cannot buy it; physical quantity is deducted through the existing fulfillment flow. Motor failure is not proof of delivery, and the email does not claim otherwise.

The phone carries the signed QR to Oracle; it never receives mailbox credentials. SMTP failure cannot guarantee immediate inbox delivery. QR telemetry remains capacity-limited (max eight items), and final telemetry can be trimmed to preserve a payable QR. No claim of guaranteed notification for omitted telemetry is made. No real emails, payments, deployment, or Pi tests were performed by this audit.
