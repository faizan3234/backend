# App records and stock consistency

## Deployment and feature switch

Deploy the bridge and matching customer-web PR. On **Oracle**, set `RELIV_APP_REPORT_SYNC=true` and restart the bridge to enable structured report export. Default/`false` disables new exports. Payment, codes, optional report email and already saved phone records continue normally. This is an environment switch controlled by the operator, not by an email address. No new secret or signing key is needed; do not rotate existing keys/pepper.

`GET /api/v2/app-features` exposes only the boolean. Rate-limited `POST /api/v2/app-record` requires the original encrypted signed QR package, exact payload fingerprint, captured PAID health-check order, and stored snapshot. It returns structured patient/readings/summary/actual scan ordinal, not PDF, confirmation code, PIN or email. Existing QR is a bearer capability: customers should keep it private. No lookup by guessable name, email or request ID alone. Unlinked old scans are not silently merged with another person.

The Pi stays offline. Each scan reaches Oracle when its QR is scanned using phone Internet. Installed apps cannot receive future measurements until those measurements are carried to Oracle. The frontend stores an encrypted local vault, supports consent per private profile and encrypted backup/import. This is not cloud-account or cross-device synchronization.

## Stock and email evidence

Existing low-stock code handles quantities **2, 1, 0**, after server-verified payment/recovery. SMTP sender is `relivcustomercare.in@gmail.com`, recipient is `khanfaizan3234@gmail.com`. Oracle needs that mailbox's SMTP credentials configured. The phone carries the signed stock snapshot; the customer's mailbox is never used. Tests use a mock SMTP transporter and do not send real mail.

Emails include medicine name, kiosk, last recorded quantity, unit price, observation time and item reference in plain language. Identical inventory revisions are deduplicated; known failures can retry, ambiguous SMTP acknowledgement requires review. Sending is requested immediately after payment verification, but delivery speed depends on Oracle/SMTP and cannot be guaranteed.

The count is captured **before dispensing**, when the QR is made. A transition from 1 to 0 after that payment cannot reach Oracle until another signed QR is carried by a phone. Do not describe the email as real-time current stock. Offline stock cannot report itself without a transport path.

Local physical stock is deducted following a validated completion ACK. Reservations reduce available-to-buy stock earlier. This PR makes job completion plus stock deduction one synchronous SQLite transaction: disk/database failure rolls back both; repeated completion cannot deduct twice. Failure ACKs remain manual-review evidence. Motor ACK still does not prove that a packet fell into the tray; real drop sensing/on-site inspection is required for that.

## Validation

- `node --check server.js` and `src/services/fulfillmentManager.js`
- `npm run test:kiosk`: 37 tests including atomic rollback, replay and missing reservation.
- `npm --prefix payment-bridge-service test`: signed export authorization, flag off, actual ordinal/summary, low stock 2/1/0, SMTP failure, receipt concurrency, payment verification/recovery, health reports and story summary.
- Frontend tests separately verify local stock display, payment identity, encrypted records and card rendering/export.

Not verified remotely: real Pi/MQTT/motor delivery, live Oracle secrets/SMTP or recipient inbox, real payment, Android/iOS installation. Deploy and perform those checks before calling the system production-verified.
