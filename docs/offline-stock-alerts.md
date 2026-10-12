# Offline stock email relay and report numbering

## Deployment
Deploy the Oracle bridge first, then the Pi backend, then the customer website. Existing payment QRs remain supported. Schema additions preserve existing payment, inventory, profile and credential data.

On Oracle only, configure `RECEIPT_GMAIL_USER=relivcustomercare.in@gmail.com` and its `RECEIPT_GMAIL_APP_PASSWORD` using the existing receipt email configuration. Never put SMTP credentials in Vite, the QR, or the customer's phone. The fixed internal recipient is `khanfaizan3234@gmail.com`. Tests inject a fake transporter; no real messages are sent.

## Actual behavior
At QR creation the Pi reads physical SQLite inventory (quantity 0, 1 or 2), including item ID, name, unit price, inventory revision and snapshot timestamp. Up to eight records are signed and encrypted together with the existing payment package. Cart quantity is not treated as stock quantity. Telemetry is trimmed if necessary before it forces the QR beyond M error-correction capacity; it must not block payment.

The phone carries this opaque package to Oracle using its own Internet connection. After server-verified payment (including payment recovery), Oracle attempts a separate internal stock email without delaying the customer response. The customer does not need to request a report email. Scanning an unpaid QR alone does not send an alert. A bounded Oracle worker checks durable paid orders on startup and every 30 seconds, so closing the phone or restarting Oracle does not discard work that has not yet been sent. No customer mailbox permissions are requested and the stock email contains no customer email, name or health data. Failed operational mail does not undo the payment or the customer's report delivery. Ads use their existing flow; no extra QR, payment or dispensing action is created.

The email explicitly says **stock at QR creation, before dispensing**. It is NOT a delivery ACK. With no Pi Internet and no second transfer, a phone cannot know that its own later dispense changed quantity 3 to 2. A subsequent customer's QR can carry that updated count. The last dispense cannot be reported immediately under this architecture. Inventory items beyond the bounded snapshot/QR capacity may also be deferred. Immediate post-dispense alerts require an additional transfer path.

Deduplication persists in `low_stock_alerts` by kiosk/item/quantity/inventory revision, across customer requests and bridge restarts. Explicit SMTP rejection or a known pre-connection failure is retried after 60 seconds by Oracle, without another customer request. A lost SMTP acknowledgement becomes `UNKNOWN`; an abandoned `SENDING` claim becomes `UNKNOWN` after five minutes. The request is marked `REVIEW` and a warning is logged. Do not blindly replay uncertain sends. SMTP cannot guarantee exactly-once delivery after an ambiguous network failure. Verify the operations inbox before manually retrying an uncertain send. The Pi still requires no connectivity. An Oracle worker and correct SMTP credentials are required; no delivery guarantee is claimed. Snapshots received by Oracle over 24 hours ago are skipped to avoid sending old stock as a fresh warning. A newer paid snapshot of the same item supersedes an older one. This does not detect unrelayed restocking or a bad Pi clock; each email explicitly states its observation time.

## Reports
The kiosk-signed `scanNumber` remains the report ordinal, even if the first emailed report is Scan 8. Successful and already-sent API responses return that ordinal as `totalScans`; `retainedReports` separately counts reports available online. PDF filenames and email subjects retain the same ordinal. Cloud history remains scoped to the existing private profile identity. Legacy QRs without a signed ordinal cannot recover missing local visits.

## Validation
Run `npm run test:kiosk`, `npm run test:ads`, `npm test`, and `npm --prefix payment-bridge-service test`. The legacy root security test requires a verification public key at startup; use an isolated synthetic key for local tests, never production signing material. Real SMTP, real Pi dispensing, phone relay and installed icon refresh need deployment/device verification.

## Scenario audit and operational visibility

| Scenario | Behavior |
| --- | --- |
| Paid customer skips email, closes phone | Oracle sends independently once payment is verified |
| Repeated scan, refresh, two concurrent requests | Durable request claim and inventory-event deduplication |
| Same quantity after restock | New inventory revision permits a new alert; the revision currently uses Pi timestamps, so reliable Pi time matters |
| Payment not captured / failed / abandoned | No stock email |
| Oracle restarts before dispatch | Startup sweep discovers the paid order |
| Oracle restarts during SMTP or acknowledgement is lost | UNKNOWN / REVIEW; manual inbox reconciliation |
| Wrong SMTP credentials / recipient rejected | Durable retry; payment and report delivery are unaffected |
| Phone never reaches Oracle | No relay possible; another phone transfer is required |
| QR capacity drops telemetry | Payment fields are preserved; an inventory alert can be omitted |
| Inventory changes after QR, including restocking | Cannot know until another snapshot arrives |
| Old snapshots | Suppressed after 24 hours from Oracle receipt; newer paid snapshot supersedes older |

On Oracle inspect `SELECT status, COUNT(*) FROM low_stock_dispatch GROUP BY status;` and `SELECT event_key, request_id, status, updated_at FROM low_stock_alerts WHERE status='UNKNOWN';`. These are internal operational tables, not a customer API. Verify the sender mailbox and recipient inbox before deciding whether an UNKNOWN event was delivered. Do not reset all alerts or alter payment rows to force retries. No health/profile or payment secrets are required for reconciliation.
