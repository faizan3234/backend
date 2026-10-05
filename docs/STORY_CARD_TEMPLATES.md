# Personalized story templates

The owner's three supplied JPEGs replace the purple story card in the paid Reliv7 page and the optional report-email attachment. Individual selects solo.jpeg; Friends selects friends.jpeg; Couple selects couple.jpeg. Original artwork is preserved, with names, scores, highlight and a shared goal written into the blank areas. Layout coordinates in storyLayout.js match those on the bridge.

The bridge computes the existing body-score estimate from the verified signed health snapshot; a client-supplied score is ignored. The phone prefills the paid snapshot's name (display nickname supports up to 20 characters). The owner can edit it and must consent before saving/sharing/emailing the optional image. No new payment is created by selecting or saving a card.

Today's Win selects Healthy BMI for valid adult measurements in the adult reference range, otherwise Good oxygen level for an available in-range oxygen reading. Otherwise it says Completed my check-in. This is one positive highlight, not proof of overall good health. It never infers great hydration from an estimated body-water percentage. References: https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html and https://medlineplus.gov/lab-tests/pulse-oximetry/ . The existing score is an estimate, not a validated diagnostic rating.

Only one verified person's report is available in this flow. Friends/couple designs include the entered second name, but mark that score unavailable and explicitly say Second scan not linked. No identity match, second result, medical ranking or winner is fabricated. A secure two-report linking flow is not implemented here.

Deploy the backend payment-bridge-service to Oracle before the frontend to Reliv7 so verified name/highlight are supplied. Do not change the Pi's payment keys. No live payment or email was sent during validation.

The Pi report-review flag remains ON in config/kiosk-features.json. Test with an existing name/PIN and completed paid scan: it should go directly to report 1, with no new measurement or payment. Backend tests verify enabled/disabled access, wrong PIN, expiry, lockout and no new paid scan; frontend review tests cover the corresponding flow. Actual Pi deployment cannot be confirmed remotely. If it still shows the normal flow, check GET /api/kiosk/features and whether RELIV_REPORT_REVIEW_MODE overrides the JSON file; see REPORT_REVIEW_MODE.md.
