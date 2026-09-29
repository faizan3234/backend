# Backend audit: 29 September 2026

## Owner admin password provisioning

The owner-requested password is installed as a salted PBKDF2 verifier for `khanfaizan3234@gmail.com`. It is enforced by normal server-side password verification, not a frontend password check or authentication bypass.

`ownerAdminProvision.js` supplies a versioned migration. On the first account lookup after deployment it replaces the previous verifier and persists its version. Later password resets preserve that marker so subsequent restarts do not restore the provisioned password. Other admin accounts are unaffected. Persistence failure fails closed. Existing session expiry, authorization and rate limits remain enabled.

The requested credentials apply only after this backend is deployed. This PR does not alter the kiosk Wi-Fi password.

## Offline payment and delivery follow-up

Rebased onto main, which already includes the ad payment lazy-initialization fix (#22). Do not replace existing `PAYMENT_V2_CODE_PEPPER` or signing/encryption keys: pending payment codes rely on them. Restart the Pi backend after deploying and preserve its `.env`, SQLite database, media and keys.

- `/health` now runs the real SQLite health query and reports MQTT disconnection as degraded. Missing MongoDB does not crash the endpoint or make the offline Pi unhealthy. The endpoint neither sends alert emails nor waits for Internet services.
- Unconfigured optional MongoDB, Drive, local email and cloud statistics are skipped by comprehensive monitoring. Explicitly configured failed services still report failures. Cloud receipt/report credentials belong on Oracle, not the offline Pi.
- Concurrent same-recipient receipt retries share one SMTP operation in the bridge process. Completed sends use the existing durable SENT record; failed sends release the in-flight guard for retry. This is not an exactly-once guarantee across multiple bridge workers or a crash between SMTP acceptance and SQLite acknowledgement.
- A concurrent health-report request with a different recipient is rejected instead of receiving the first recipient's download token.
- The portal installer allows nginx workers time to reload before deciding to restore the configuration, and reports a specific redirect-check failure. Your manually observed 302 to `/advertise` already confirms the HTTP redirect; phone DNS/sign-in behavior still needs on-site verification.

## Passed checks

- `node --check server.js` and `node --check src/services/adminAuth.js`.
- `npm run test:kiosk`: 13 tests, including owner password migration, rejection of the previous password, persistence failure, password reset and restart behavior.
- `npm run test:ads`: 6 tests covering pricing/media contracts, signed payment handoff, activation, scheduling and replay protection.
- `npm test`: payment/security, authoritative pricing, cart lifecycle and QR capacity regressions.
- Captive portal installer shell syntax checked; existing portal configuration redirects supported OS connectivity probes to `http://192.168.50.1/advertise`.

- Oracle bridge: `npm run check` and `npm test`, including receipt concurrency/failure recovery, server-authoritative payment checks and 22 health-report assertions. SMTP and gateway calls are simulated; no customer was charged or emailed.
- `node --test test-local-health.js` covers real-check invocation, absent cloud configuration, unavailable SQLite and disconnected MQTT.

## On-site deployment requirements

Deploy the matching frontend audit PR. Preserve external configuration and database/media storage. Configure the local nginx SPA/API proxy and use `ADS-DEPLOYMENT.md` for the portal. From the Pi console, run `sudo bash deploy/install-ads-captive-portal.sh --check`; where installation is needed, follow its `--apply --reconnect` procedure. Reconnecting the AP disconnects Wi-Fi clients and SSH sessions.

The wall poster's main QR is a standard Wi-Fi payload for RELIV-KIOSK; it does not encode a second browser action. The portal provides that action after joining when the phone permits it. A smaller URL QR opens `/advertise` after the phone is connected, without typing. Universal automatic browser opening cannot be enforced across phones/scanner apps.

Physical Pi Chromium rendering/performance, phone captive-portal prompts, live Razorpay payments, hardware dispensing, long-running memory behavior and power-loss recovery are not verified by these automated tests. This audit does not guarantee zero bugs or production readiness before those deployment checks.

### Oracle payment/email configuration

Deploy `payment-bridge-service` from this backend PR to Oracle as well as deploying the Pi backend locally. In the Oracle bridge environment, keep the existing Razorpay keys, trusted kiosk public key, cloud private key and code encryption secret. Configure `RECEIPT_GMAIL_USER` and `RECEIPT_GMAIL_APP_PASSWORD` there. From that directory run `node check-email.js` (SMTP login check, no email sent), then restart the existing bridge process. See `payment-bridge-service/EMAIL_RECOVERY.md`. Restarting only `node server.js` on the Pi does not update Oracle. No process manager is assumed on the Pi; stop its existing manual process before starting the updated one.

Three hardware fulfillment jobs in the supplied logs require manual review. Do not replay or delete them automatically: inspect whether items physically dispensed before resolving them.
