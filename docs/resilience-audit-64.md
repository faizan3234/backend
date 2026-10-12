# Follow-up to the 64-scenario audit

This is a code/test assessment, not certification of every physical or distributed failure mode.

| Scenarios from checklist | Software coverage and remaining boundaries |
| --- | --- |
| 1–12 payment, retry, duplicate callbacks | Existing server verification and payment identity tests retained; alerts depend on verified captured payment, not customer email. Full payment and cloud suites rerun. |
| 13–22 phone/offline/network interruptions | Durable cloud work survives a phone leaving after delivery to Oracle. No communication is possible before a phone reaches Oracle. Phone OS/network transitions require device tests. |
| 23–26 signed package integrity | Existing signature, tamper, bounded decompression and malformed stock tests rerun. |
| 27–28 QR capacity and repeated omission | Only transmitted stock items advance their relay position, allowing omitted items priority in later requests. Actual core payment fields remain intact. A permanently full QR remains a limit. |
| 29–34 thresholds and final dispense | Snapshot quantity 0/1/2 verified. It remains pre-dispense; post-dispense transitions and the last emptying cannot be inferred without another transfer. |
| 35–40 jam, duplicate/lost ACK, reservation, restart | Existing kiosk/MQTT/fulfillment regression suites retained. Real motors, sensors and power-loss behavior remain hardware validation. |
| 41–44 refill, same-second changes, clock rollback | Added persistent per-item numeric revisions and clock-independent cloud comparison. Covered by new tests. |
| 45–48 identity, admin edits, physical discrepancy | Event key includes kiosk/item/revision. Quantity/name/price edits advance revisions. Cloned signing identities and actual physical stock mismatches require operator/device reconciliation. |
| 49–53 crash and concurrent workers | Existing durable claims/UNKNOWN review retained. Independent SQLite files across Oracle machines are NOT a shared queue; use one persistent deployment/shared coordination. |
| 54 database failure | Removed automatic rename/empty-database recreation and WAL deletion. Initialization fails closed and releases the failed connection. Corrupt fixture remains byte-identical in test. Disk-full and power-loss require operational testing. |
| 55 backup restore | Restored payments and revisions can roll back. Manual reconciliation still required. No claim of exactly-once after rollback. |
| 56–61 SMTP failures, throttling, ambiguity | Added persisted attempt count and exponential backoff capped at one hour. Explicit failures retry; uncertain acceptance stays REVIEW. Real Gmail spam, bounce and read status cannot be proven by SMTP acceptance. |
| 62 expiry | Expired snapshots now receive EXPIRED status instead of being counted DONE. |
| 63–64 text/privacy | Fixed server-owned sender/recipient and operational-only stock body retained. Unicode QR/report regressions run; no customer mailbox access added. |

## Audio and data correctness
- Cancellation now pauses the owning Audio element before clearing its reference. This fixes old audio surviving replacement/unmount.
- Browser synthesis fallback releases the HTML audio channel first.
- Unlock AudioContext is reused, resume rejection handled, and context closed on teardown.
- Invalid volume values do not enter state.
- Removed invented missing values and unconditional healthy/green claims from the legacy backend reportSpeechService helper. It narrates supplied values or explicit unavailable text in EN/HI/BN. Existing frontend tailored report generation remains in place; this does not clinically validate every derived model elsewhere in the product.

## Deployment
Deploy Oracle first (recognizes numeric revisions and durable retry counters), then Pi backend (creates additive revision table/triggers), then frontend. Preserve the Pi/Oracle databases and WAL, credentials, media and signing material. No production keys or database contents are replaced by this change. A startup database error now deliberately requires recovery instead of silently opening an empty kiosk.

## Evidence
Backend kiosk, advertising, payment, cloud, QR, report and new preservation/revision tests; frontend full test command, lint and production builds. Detailed results are recorded in the PR. Real Pi Chromium audio/accent, touchscreen layout, hardware dispensing, SMTP delivery and power interruption remain on-site checks. No live payments/emails were made during tests.
