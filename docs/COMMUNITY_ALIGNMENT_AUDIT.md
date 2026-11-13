# Shared community ledger and customer contracts — 13 November 2026

Deploy together with the frontend alignment PR after review. Nothing here merges or deploys either repository.

## Architecture and rules

The online Oracle bridge owns the persistent SQLite growth ledger. The customer app reaches it through the Vercel `/api/growth/{referrals,analytics,admin}` proxy. The offline Pi does not run a competing leaderboard.

- Cryptographically random registered codes, hashed registration/session secrets, server-side validation, one referrer per invitee, cycle rejection, transactional one-time rewards.
- Accepted referral = 1 point; verified Google identity plus activity on three server IST dates = 10 points total. Sorting and names come from the shared server. Zero-referral members do not appear in the ranking.
- Public responses contain display names/member IDs and referral counts, not phone numbers, email, Google subject IDs, installation data or health records.
- Google tokens are checked for signature, issuer, audience, expiration and verified email. Administrator requests additionally require the configured passkey and email allowlist. Both checks are server-side.
- Google recovery rebinds the browser registration to the original member and removes duplicate referral eligibility. It cannot recover health records stored only on a different phone.
- An anonymous browser is not a verified physical device. Browser-reported activity/installation signals are not proof of exercise, eating, unique phones, or actual downloads. Prize approval remains a staff decision; no money is paid automatically.
- ₹50 voucher redemption and automatic milestone refunds are not implemented and are not reported as available. No invented payment/order success remains on the legacy growth/store/streak endpoints.

## Data preservation

Before installing, back up the Oracle database using SQLite's backup command (not a plain copy while WAL writes are active), and back up the Pi database separately. Use an absolute persistent `DATABASE_PATH` on Oracle and retain the same file across restarts.

The older `growth_referrals` schema is renamed to `growth_referrals_legacy_v1`. Its records are retained for staff review; unverified browser-supplied IDs/scores are not promoted automatically. Other historical tables are left intact. This is a new authoritative membership ledger: users must share their current registered codes. The admin dashboard reports the legacy row count.

Generic UI support reports use `ui_support_issues` rather than overwriting paid-order `support_cases`. Retries are idempotent, database failures return 503, and success never claims an email was sent. On the Pi, authorized staff can read the latest 100 at `GET /api/admin/ui-support-issues` using the existing admin bearer token.

## Required environment

Oracle `payment-bridge-service`:

| Variable | Required value/purpose |
| --- | --- |
| `DATABASE_PATH` | Absolute persistent SQLite path; do not change to an empty temporary file. |
| `GOOGLE_CLIENT_ID` | Same web OAuth client ID as the customer app. |
| `GROWTH_ADMIN_EMAILS` | `khanfaizan3234@gmail.com` for the owner; comma-separated explicit allowlist if expanded. |
| `GROWTH_ADMIN_PASSKEY` | Strong server-only administrator secret; no public default. |
| `GROWTH_PROXY_SECRET` | Strong secret shared only with the Vercel proxy; prevents forged client rate-limit identity. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Existing web-push configuration; dependency is now in package.json and package-lock.json. |
| Allowed origins | Explicit customer app origins; arbitrary Vercel preview domains are not automatically trusted. |

Vercel: `RELIV_GROWTH_API_URL=https://YOUR_ORACLE_HOST/api/growth`, the same `GROWTH_PROXY_SECRET`, and public `VITE_GOOGLE_CLIENT_ID`. All secrets remain server-side. Retain the working Razorpay and Reliv sender-mail environment. Rotate previously committed Razorpay secrets before enabling payment traffic with these credentials.

The Pi owner login is `khanfaizan3234@gmail.com` with the owner-requested `Reliv-17` provision. Only its PBKDF2 verifier is stored server-side. This is a one-time versioned provision; later password resets are preserved. Growth admin is a separate, online Google-plus-server-secret login.

## Fixed logic problems

| Before | After |
| --- | --- |
| Browser could choose user IDs/scores, fabricate referral identities, call unprotected reset, or claim fake payments | One authenticated ledger; old mutation routes return a controlled 410/503; no fallback confirmation. |
| Repeated registration/claim or recovery gave competing identities | Transactional idempotency, preserved recovery mapping, duplicate grants/replays audited. |
| Staff inventory form could overwrite stock sold since it opened | PATCH requires `expected_quantity` for quantity changes; 409 if stale, 428 if missing. Deploy the paired frontend form. |
| Health PDF URL could bypass profile access | Download requires authorized profile/session state; unpaid/private reports remain protected. |
| Arbitrary card-email endpoint could relay user HTML and report fake “queued” status | Retired; existing authorized paid-report delivery APIs remain. |
| Support success was returned even when database writes failed | Actual durable record and reference required; explicit failure otherwise. |
| Node tare endpoint said “calibrated” without hardware acknowledgement | Explicit unsupported response; the actual BLE scale service on port 5001 is unchanged. |
| Push module was missing, mute settings ignored, malformed dispatch state could stop the loop | Locked web-push dependency, preferences carried to worker, bounded dispatch history and malformed-state recovery. |

Low-stock alert behavior was verified, not redesigned: paid requests independently trigger durable alerts for expected stock transitions 3→2, 2→1 and 1→0 even if no customer receipt is requested. Retries/restarts do not duplicate completed alerts. Messages distinguish a signed pre-dispense snapshot and expected remaining stock from confirmed physical delivery. The Pi remains the stock authority; the phone cannot prove a jammed motor delivered medicine.

## Validation

- `npm run test:kiosk`: 47 passing tests.
- Root `npm test`: all suites passed (61 security, 146 payment, 24 pricing checks, cart lifecycle, 8 QR capacity tests).
- Bridge `npm run check`: syntax passed; root `node --check server.js` passed.
- Bridge `npm test`: all suites passed, including stock alerts/SMTP failures/concurrency, payment and report verification, PNG card, push, growth, legacy migration and request expiration/skew.
- Shared-ledger browser integration exercised the paired frontend against these real routes/SQLite at 320×740, 390×844, 1280×800.
- Test logs include deliberately simulated SMTP rejection, invalid payments and service outages; assertions confirm controlled failures, not successful live delivery.

## Final installed-system checks (not performed here)

1. Verify `/health`, `/api/notifications/health` and `/api/growth/referrals?action=leaderboard` on Oracle after configuration and restart.
2. Two real phones: same leaderboard, one grant on repeat claim, Google recovery, denied non-owner administrator access. Verify a real push with the PWA closed; iPhone/Android permission and OS behavior still apply.
3. Pi: real sensor/scale/MQTT readings and speakers in each language at 1280×800, offline report navigation, restart recovery.
4. Staff-supervised paid medicine transaction: correct code, dispense acknowledgement, correct stock decrement, no extra dispensing on retries, independent low-stock email from the configured Reliv sender to the owner. Confirm delivery with tray/sensor evidence; never equate a timed motor cycle to proof of medicine delivery.

No live Razorpay payment, SMTP delivery, physical dispensing or Pi audio was tested in this workspace.

## Reconciled with the 13 November main branches

The newer name banner, ad venue choices, tiered ad estimates, notification click callbacks and layout changes have been retained. Referral persistence uses the authenticated Oracle ledger through the same-origin proxy. The newer unauthenticated Supabase/client-ledger and public reset routes are replaced, not run alongside it: running two authorities would split rankings again. Existing local legacy tables and external Supabase rows are not deleted. Export/review earlier records before deciding whether to import any identity or award; previously client-supplied scores are not proof of valid referrals. Disable public write access to the old Supabase tables after the coordinated change.

Additional regressions caught: missing readings were replaced with 120/80, 98% and BMI 22.4 in the new AI analysis; these defaults are removed. The analysis now explains only available readings and saved nutrition targets. Ad previews use object URLs instead of copying up to 50 MB into base64 state. The three newer store email endpoints accepted arbitrary recipients and claimed dispatch even when no mail was sent; they now fail explicitly until a durable, verified store service is configured. Email/WhatsApp enquiry drafts remain available. Short reminder timers use one tracked interval, bounded inputs and cleanup, without claiming background delivery.
