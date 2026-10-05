# Private report history and narration

The name/PIN review route opens the latest completed paid report already linked to that private profile. Its earlier paid scans are returned to the same authenticated profile only.

History readings are exposed in both the original flat shape used by the progress graph/narration and the nested `vitals` shape used by body-composition report cards. The nested history only includes allowlisted finite positive values actually saved with that visit; impedance remains nested for the prior-visit body-composition calculation. Historical names, email, and PINs are not returned. Available recorded body-fat/water values take precedence over formula estimates in graph narration.

If no earlier record exists, the report uses the current actual saved readings as a one-scan baseline. It no longer fills a missing history row with sample blood pressure, oxygen, weight, or body-composition values. The progress-page voice reads prior scans in order, one scan heading and its available measurements. It skips missing values and does not repeat the current values already spoken on the previous page. Existing offline English, Hindi and Bengali recordings cover every emitted phrase and number.

Visits recorded before a PIN profile was linked cannot safely be attached by name alone; this change deliberately does not infer that identity. They remain outside the profile's private history until there is a verified identity link. The review flag stays ON in `config/kiosk-features.json`.

Checks: backend private-profile history tests cover paid-only scan ordering, private demographics, actual body-composition fields, scan counts, and the temporary review flag. Frontend narration tests cover visit order, no repeated current values, missing readings, body-fat/water values and local audio availability in all three languages.
