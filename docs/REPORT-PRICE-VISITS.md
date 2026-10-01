# Local report price and visit metadata

Companion frontend change: report measurements visible on every paid report page, optional customer email, no report QR, and no stale report hydration.

## Price

`SettingsManager.initialize()` applies `migration_report_price_17_v1` once inside a SQLite transaction. Existing and new databases get ₹17 in the legacy report/health-price keys. Later admin changes are preserved across restart. `PricingService` uses `getReportPrice()` for new HEALTH_CHECKUP transactions and payment requests, in paise. Medicine pricing and existing payment requests are unchanged. Invalid/nonpositive report prices fail validation.

## Visit metadata

The already authorized paid `/api/sessions/:sessionId/report/data` response adds `scanCount` and `identityLinked` within `healthData`. Sensor values still come only from the frozen paid snapshot. `history` is explicitly empty: an email is not sufficient authorization to disclose earlier health records.

Local visit counts include HEALTH_CHECKUP sessions whose payment is VERIFIED and report is READY/EMAILED, up to the current session's row sequence. They exclude unpaid visits, medicine sessions and other emails. Email matching trims whitespace and ignores case. Reloads and page navigation do not add visits. With no email the current visit is unlinked and displayed as scan 1. These counts are not verified identity, physiological trends, or clinical confidence.

## Deploy and verify

After merging both PRs, update `~/backend`, run `npm ci`, and restart the existing Node process (do not start another listener). Build/deploy the companion frontend. The price migration runs at backend startup; no manual database edits are required. Create a new health-check session and confirm the payable amount is ₹17. Old payment requests retain their original amount.

Validation: `npm run test:kiosk`, `node test-pricing-authoritative.js`, and `node --check server.js`. Tests use isolated databases and synthetic payment/email dependencies. Real Pi hardware, real payment settlement and delivery while offline are not certified by these tests.
