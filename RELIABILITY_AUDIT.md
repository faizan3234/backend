# Reliability audit — 12 September 2026

Based on main `ac13a20`, paired with frontend main `02b0a8f`. Proposed branch: `codex/reliability-kiosk-latest` in both repositories.

| Problem | Customer/admin impact | Change |
| --- | --- | --- |
| Receipt INSERT omitted required cart/amount | Paid customer could receive a receipt error | Persist required fields; test real PDF and database inserts. |
| Concurrent PDF requests | Duplicate documents and email jobs | Coalesce generation and reuse existing valid files; regenerate missing files. |
| Legacy unbound report/receipt endpoints | Supplied data could bypass paid-session rules or change inventory | Route through the authoritative paid-session handlers. Session ID is required. |
| Recovery email treated as report PDF | Admin reset email failed due to missing attachment | Expiring text-only recovery type, with queue migration preserving old events. |
| Default-password bypass / unguarded admin writes | Unauthorized inventory or speech edits | Configured credentials, expiring bearer sessions, rate limits and reset-token consumption. |
| Missing speech PUT / price setter | Admin save failed | Offline speech persistence and validated report-price setter. |
| Failed emails remained pending indefinitely | Admin could not distinguish exhausted retries | Mark terminal failures after five attempts; validate real PDF attachments. |
| USB microphone cleanup could throw | Voice service stopped after an unplug | Independent cleanup guards and interruptible reconnect; exclude output loopback devices. |

Validation: 262 payment/security/pricing/cart assertions, 10 offline API/reliability tests, 20 cloud-report assertions and 34 Python voice tests. Synthetic accounts, temporary databases and mocked mail/provider operations only. No real emails or payments were initiated. Frontend performs the 26-route DOM walkthrough and payment/help/console checks.

Deploy the paired frontend/backend together. Existing configured admin accounts continue to work. If no account exists, set `RELIV_ADMIN_EMAIL` and a private `RELIV_ADMIN_PASSWORD` (at least 12 characters) in the backend service environment. Never expose these through Vite or git. Restarting the backend expires admin login sessions. Recovery email needs a working deployed mail transport.

The migration adds `EMAIL_ADMIN_RESET` while retaining queued rows. Follow the normal database/credentials backup procedure before deployment. Legacy `/api/send-receipt` and `/api/save-report` now require a paid session ID, with authoritative amounts and measurements; unbound legacy requests are rejected.

Pending physical acceptance: Pi touchscreen scrolling, real mic latency/acoustic echo, sensor readings, motor dispensing, provider payment, and delivery to an actual phone email address. Automated success does not certify a crash-free deployment. Full progress table: frontend `docs/DEPLOYMENT_CHECKLIST.md`.
