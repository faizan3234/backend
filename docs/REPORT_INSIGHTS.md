# Report, speech and payment fixes — October 2026

## What changed

The online gateway resolves the scanned encrypted package before consulting any saved callback. Recovery records are scoped to their package/request; QR changes remount the attempt and late replies cannot reveal an older code. Unsettled callback evidence is preserved. Payment amounts and codes remain server-authoritative.

The kiosk has five distinct report pages: body overview, measured vitals, multi-metric history, bar comparisons/table, and next steps. BP is red/orange, oxygen blue, temperature green, pulse purple. Each series has its own labelled scale: mixed physical units must not share a numerical axis. All six core series show initially; a button isolates a series. Charts show the most recent 12 retained scans; the table shows up to 100 private records. A first scan produces one point/bar per available series, without invented historical points.

Seven sensor values plus up to nine calculations/estimates give 16 available fields for eligible adults. Two complete scans represent 32 observations, not 32 independent parameters. Historical estimates use the demographics recorded at that visit. Missing historical demographics do not use today's age as a substitute.

Every report explanation, number from 0–240, decimal digit, unit and status has bundled English/Hindi/Bengali speech. Larger integer values are read digit by digit. This build has 314 generic clips per language packed into seekable MP3s. No patient names/data were sent to the build-time voice service. Report speech needs no internet or installed language voice. Measurement screens use the existing exact bundled prompts and visible Listen/Stop controls. Local Hindi/Bengali fonts prevent missing glyphs offline. Speech controls no longer cover Next. Report narration counts as activity; after it ends the existing four-minute inactivity warning applies.

Report page 5 reopens the same captured order on the customer's online phone. No kiosk Wi-Fi connection is needed. Optional friend/couple cards contain consenting nicknames only, support PNG download/share on the phone, and can be attached as PDF to the first report email. They celebrate shared habits, do not rank medical health, and do not automatically post to Instagram or promise a repost. The email path requires the matching backend/Oracle changes.

## Estimate provenance and limits

`bodyEstimates.js` is byte-identical to the Oracle copy. Applicability is deliberately limited to recorded ages 20–78, heights 100–230 cm and weights 20–300 kg. Male/female formulas use the profile's recorded category; other/unknown categories receive BMI/BSA only. Results are labelled population estimates, with no invented healthy threshold. Pregnancy, illness, fluid shifts and athletic builds can invalidate assumptions. Water is part of fat-free mass; it is not an additional pie slice, dehydration test or drinking recommendation.

- BMI: kg / height(m)^2; adult references: https://www.niddk.nih.gov/health-information/weight-management/adult-overweight-obesity/am-i-healthy-weight
- BSA: Mosteller, sqrt(height(cm) × weight(kg) / 3600).
- Resting energy: Mifflin–St Jeor; https://pubmed.ncbi.nlm.nih.gov/2305711/
- Body fat percentage: Deurenberg adult BMI/age/sex equation; https://pubmed.ncbi.nlm.nih.gov/2043597/ . Fat mass, fat-free mass and FFMI derive from that estimate, not an impedance sensor.
- Body water: Watson adult equations; https://pubmed.ncbi.nlm.nih.gov/6986753/ ; coefficient implementation also documented in https://pmc.ncbi.nlm.nih.gov/articles/PMC2782201/ . The formulas do not assess an individual's hydration.

No validated metabolic-age or visceral-fat measurement exists in the supplied sensor flow. The former arbitrary age buckets/visceral-fat heuristics are not restored. The screen explains this and supplies a labelled resting-energy estimate where possible.

Traffic cues are adult screening references, not diagnoses: BP uses both systolic and diastolic values (https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings); pulse uses 60–100 bpm; oxygen uses 95–100% as usual, 93–94% recheck and <=92% prompt medical attention (https://medlineplus.gov/lab-tests/pulse-oximetry/). Temperature below 95°F or at/above 100.4°F is flagged (https://www.nhs.uk/conditions/hypothermia/ , https://www.nhs.uk/symptoms/fever-in-adults/). Severe values/symptoms must not wait for another paid scan. Device accuracy, clinical interpretation and translated clinical copy still require on-site/clinical review.

## Verification and deployment

Run `npm run lint`, `npm test`, `npm run build`. Regression coverage includes old paid/new unpaid QR, pending-proof preservation, same-tab QR change, late response, leading-zero code, report authorization, all five routes, gaps, estimates, speech without browser/backend TTS, ads and measurement handling.

Chromium desktop 1920×1080 and phone 390×844 checks use synthetic data. PDF/card renders and real MP3 decoder seeking were checked. They do not establish real Pi speaker output, touchscreen/sensor calibration, live Razorpay capture or live email delivery.

Deploy the backend to the Pi and its `payment-bridge-service` to Oracle, then deploy the frontend build to both the Pi and reliv7. Preserve existing database, media, credentials, peppers and signing keys. Restart the Pi backend with the existing manual `npm start` process. Do not regenerate keys.

Build-time audio regeneration only: install `edge-tts` in a Python environment and `ffmpeg`; set `RELIV_TTS_PYTHON` and optionally `RELIV_AUDIO_BUILD_DIR`, `HTTPS_PROXY`, `SSL_CERT_FILE`; run `node scripts/generate_insight_audio.mjs`. Deploy all generated MP3s together with `manifest.json`. This is unnecessary on the offline Pi.
