# Offline customer help and evidence

This extends backend PR 43 and frontend PR 70. Install the backend first, then the kiosk and customer-web frontend builds. No cloud service or Internet is needed to save/review a local case. WhatsApp/email sending still needs the customer's Internet; saving on the Pi does not notify the owner automatically.

## Customer

Payment, medicine delivery and report pages have a "Did not receive medicine or report?" button in English, Hindi and Bengali. The kiosk shows the order reference and can save one help case per session, even after the payment/session expired. Save requires the session's original pairing token. Repeated submissions return the same reference and preserve the original evidence. If the backend is unreachable, contact details and the session reference remain visible; never claim the complaint was saved.

On Reliv7's successful-payment page, the help section opens a WhatsApp draft to +91 9163606455 or an email draft to khanfaizan3234@gmail.com, with the payment request reference. The user must send it. It never includes the PIN, activation code, encrypted payment package or health measurements. Ask for receipt, time, description and optional photo. Do not ask for medical reports as proof.

## Admin

At /admin sign in, expand **Customer help & order evidence**. Recent 100 cases are listed. Older cases are still searchable by exact reference. Search a case ID, session ID, transaction ID, payment/provider order ID or payment request ID from the customer's receipt. Kiosk ID alone is not a purchase reference.

Review:
- local transaction status, amount, payment/provider/request references and verification time;
- items ordered, frozen motor/job IDs, command publish time, device reply and failure reason;
- current recorded inventory count (not a physical count, not proof of collection);
- report generation/email status (not proof the user saw it or received email);
- backend process starts since the order (not proof of a power cut);
- original snapshot at complaint time, current evidence, staff notes and resolutions.

For a phone/email complaint without a saved case, look up the receipt reference then select **Open case for this phone / email complaint**. Add findings and actual corrective action, with status OPEN, INVESTIGATING or RESOLVED. Notes append with admin identity/time; original evidence is retained. Resolving does not refund, resend reports, change stock, or run a motor. These actions require a separate verified staff procedure. Never blindly retry an uncertain dispense.

**Download evidence for support** exports this order's records as JSON for private transfer by a staff member when online. It excludes customer health readings, PINs, pairing tokens and payment packages. Keep the Pi's SQLite database/backups secure; local records are not tamper-proof against an administrator with filesystem access. This addition creates support_cases and support_notes in the existing database without replacing existing data.

## What can and cannot be confirmed

An ESP32 SUCCESS response might only mean a spring rotated. Without a calibrated drop/collection sensor and corresponding firmware, software cannot distinguish a jam after rotation from actual delivery, or truth from every false claim. This UI explicitly labels completion as **device reported**, never fraud proof. Even a drop sensor shows passage, not necessarily pickup by the rightful person. Missing/contradictory evidence requires manual review, not automatic accusation.

A reboot can be a restart, crash or power interruption. Power loss can prevent the last event reaching disk. New boot records only start after installation; old gaps cannot be reconstructed. Existing recovery keeps jobs interrupted mid-dispense in manual review. Broker receipt is not an ESP acknowledgement. Authenticated/encrypted broker access and replay-resistant dispenser firmware are separate physical/network requirements; current anonymous MQTT must not be treated as independent tamper-proof delivery evidence.

For missing reports, local generation and the Oracle receipt/email service are separate. Check the matching bridge request and email delivery record online when available. A VERIFIED local payment confirms kiosk authorization; if local verification is absent, verify the provider receipt on Oracle before rejecting a paid customer's complaint.

## Validation

Automated SQLite/HTTP checks cover expired-session complaints, wrong token rejection, immutable original snapshot, duplicate submission, authenticated lookup, payment-reference correlation, note deduplication and no payment/stock changes. UI checks cover contact fallback, rapid taps and session binding; existing delivery/speech regression checks remain passing. Physical dispensing, power interruption, WhatsApp sending, real payment/email and Pi testing were not performed.

On the Pi, file a help request for a synthetic staff order; sign in and find it by case and payment-request ID; compare the recorded job with the actual tray; add a review note, restart the backend and confirm the same case remains. Use controlled staff-only hardware checks to validate disconnected motor/jam behavior. Never test by sending a fake SUCCESS acknowledgement or repeating a paid motor command.
