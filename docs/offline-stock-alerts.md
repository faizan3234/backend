# Offline stock email relay and report numbering

## Deployment
Deploy the Oracle bridge first, then the Pi backend, then the customer website. Existing payment QRs remain supported. Schema additions preserve existing payment, inventory, profile and credential data.

On Oracle only, configure `RECEIPT_GMAIL_USER=relivcustomercare.in@gmail.com` and its `RECEIPT_GMAIL_APP_PASSWORD` using the existing receipt email configuration. Never put SMTP credentials in Vite, the QR, or the customer's phone. The fixed internal recipient is `khanfaizan3234@gmail.com`. Tests inject a fake transporter; no real messages are sent.

## Actual behavior
At QR creation the Pi reads physical SQLite inventory (quantity 0, 1 or 2), including item ID, name, unit price, inventory revision and snapshot timestamp. Up to eight records are signed and encrypted together with the existing payment package. Cart quantity is not treated as stock quantity. Telemetry is trimmed if necessary before it forces the QR beyond M error-correction capacity; it must not block payment.

The phone carries this opaque package to Oracle using its own Internet connection. After a paid customer's receipt/report email request succeeds, Oracle attempts a separate internal stock email without delaying the customer response. A process exit before that attempt finishes requires a subsequent email request to retry. No customer mailbox permissions are requested and the stock email contains no customer email, name or health data. Failed operational mail does not undo the payment or the customer's report delivery. Ads use their existing flow; no extra QR, payment or dispensing action is created.

The email explicitly says **stock at QR creation, before dispensing**. It is NOT a delivery ACK. With no Pi Internet and no second transfer, a phone cannot know that its own later dispense changed quantity 3 to 2. A subsequent customer's QR can carry that updated count. The last dispense cannot be reported immediately under this architecture. Inventory items beyond the bounded snapshot/QR capacity may also be deferred. Immediate post-dispense alerts require an additional transfer path.

Deduplication persists in `low_stock_alerts` by kiosk/item/quantity/inventory revision, across customer requests and bridge restarts. Explicit SMTP failures can retry after 60 seconds on another email request. A process crash during SMTP leaves `SENDING` for manual reconciliation; do not blindly replay it. SMTP cannot guarantee exactly-once delivery after an ambiguous network failure. Verify the operations inbox before manually retrying an uncertain send. No background connectivity or delivery guarantee is claimed.

## Reports
The kiosk-signed `scanNumber` remains the report ordinal, even if the first emailed report is Scan 8. Successful and already-sent API responses return that ordinal as `totalScans`; `retainedReports` separately counts reports available online. PDF filenames and email subjects retain the same ordinal. Cloud history remains scoped to the existing private profile identity. Legacy QRs without a signed ordinal cannot recover missing local visits.

## Validation
Run `npm run test:kiosk`, `npm run test:ads`, `npm test`, and `npm --prefix payment-bridge-service test`. The legacy root security test requires a verification public key at startup; use an isolated synthetic key for local tests, never production signing material. Real SMTP, real Pi dispensing, phone relay and installed icon refresh need deployment/device verification.
