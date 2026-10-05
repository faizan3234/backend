# Temporary report-review mode and personalized voice

## Owner switch: “feature flag off” means normal flow

The canonical switch is the Pi backend's `config/kiosk-features.json`:

```json
{"reportReviewMode": true}
```

This PR ships it **ON**, as requested for owner review. Name + the existing six-digit PIN opens that profile's latest completed paid report. The New/Returning/Medicine choice screen is hidden while this temporary mode is on. No new session, scan, payment, sensor action or dispensing job is created. A first-time visitor without a saved paid report cannot use this review flow.

To restore the normal current flow, set the same file to:

```json
{"reportReviewMode": false}
```

This is what future requests saying **“feature flag off”** refer to. Return the browser to the splash page and start again (or reload) so it reloads the switch. The backend reads the JSON on each request; changing this file needs no backend restart. If `RELIV_REPORT_REVIEW_MODE` is present in the backend environment, it overrides the file: exact `true` enables, anything else disables. After changing `.env`, restart the manually running `npm start` process. Do not set this as a frontend/Vite secret or expose an unauthenticated toggle endpoint.

With the flag OFF: New/Returning → name/details/PIN → existing service choice → normal checkup/payment/report. Normal authorized paid-report access works in either mode.

## Privacy and access

Review uses the existing profile name/PIN match and shared lockout counters. Wrong PINs do not disclose matches. The review token is random, stored as a hash on the Pi, scoped to the saved session/profile and expires after 30 minutes. Switching review off invalidates these tokens without invalidating the regular paid session credential. Finish/idle resets clear browser review credentials. No credential, database, payment key or media is deleted or replaced.

The browser still calls the ordinary private report endpoint, which checks verified session AND transaction payment, completed report state and the credential. The flag does not bypass payment for new reports.

## Tailored offline narration

All three languages reuse the established female recordings and numeric clips. Weight guidance uses actual age/height/weight, the adult BMI reference 18.5 <= BMI < 25, the corresponding approximate kilogram boundaries and the distance above/below that range. It is not a single prescribed ideal weight and is unavailable for children/missing or invalid inputs. The same numbers appear on the report card.

Body-fat/water guidance reads the available formula estimates and compares earlier comparable records using demographics stored at that visit. It describes direction and percentage-point difference, not automatic improvement or dehydration. An abnormal BMI selects the existing relevant advice. Formula estimates cannot support a definitive fat-loss prescription or fluid dose. Unsupported metric chips are hidden instead of offering a generic non-specific Listen button. Existing supported metric explanations, Replay, Stop and automatic report speech remain.

Source for the adult reference: https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html . Context/limitations: https://www.niddk.nih.gov/health-information/weight-management/adult-overweight-obesity/am-i-healthy-weight . Existing legacy body-composition formula validation is outside this change.

## Scan numbering and PDFs

A shared Pi helper supplies the private visit ordinal for the current report and signed payment snapshot. The report API sends `reportScanNumber`, which takes priority over stale nested UI counts. New local PDFs include that ordinal. The Oracle PDF distinguishes the real scan number from the count of emailed reports: Scan 7 stays Scan 7 even if only three reports were emailed. Page navigation, review and repeated emailing never add scans.

This does not rewrite PDFs already sent, replace existing signed QR payloads, or infer missing visits from an old unlinked profile. Those records cannot be repaired by inventing history. Deploy the Oracle bridge changes for newly generated phone PDFs.

## Deployment and checks

Deploy backend to Pi and its payment-bridge-service to Oracle, then frontend (including all audio files and manifest) to Pi/reliv7. Keep normal manual backend startup and all existing keys/data. This PR is not deployed automatically.

Tests cover flag on/off, latest paid report, wrong PIN, lockout, expired/cross-profile credentials, no new scan/payment, duplicate taps, scan 7 overriding stale scan 3, recorded speech, weight boundaries/missing inputs and historical composition comparisons. Full frontend lint/tests/build and backend kiosk/ads/payment/bridge suites pass. Synthetic Scan 7/three-email PDF rendered and visually checked. Pi touchscreen/speakers, pronunciation preference and live payments remain physical checks.
