# Phone booking and splash ads

Deploy this backend together with the matching frontend PR. It includes the earlier advertising API work, so do not separately merge the superseded ad PR. Back up SQLite and the ad media directory before deploying. Never replace production signing keys, cloud encryption keys or the verification pepper with test keys.

## Deployment order

1. Deploy `payment-bridge-service` to the online payment server first. It must support `RELIV_AD_PAYMENT_REQUEST`, independent ad pricing, and both the old and compressed Payment V2 packages. An old cloud decoder rejects compressed packages with an AES-GCM authentication error. Verify the configured kiosk public key and cloud private key match the Pi keys.
2. Deploy this backend to the Pi with the existing payment keys and pepper. Install `ffmpeg` and `ffprobe`; ensure the service user can write `data/ads`. The schema initializes the ad tables without replacing existing inventory or payments. Restart the backend.
3. Build and deploy the matching frontend to the Pi's local HTTP site and to `reliv7.vercel.app`. Keep existing payment bridge environment configuration. `/advertise` must work directly at `http://192.168.50.1/advertise`; `/admin` manages inventory and ad timing. `/pay` on Vercel is the Internet payment page.
4. In `/admin`, save 5, 10 or 15 seconds. This is the actual splash interval before/between ads. With no eligible ads, there is no ad overlay or fallback creative. Health pages never run ads.

Only the current kiosk is bookable: media cannot reach another offline kiosk automatically. Remote venues remain unavailable until a delivery/approval workflow exists. Pending payments reserve the slot. Unpaid drafts do not consume the eight-slot limit. A repeated confirmation returns the same payment link while valid; expired requests require recovery, never an automatic second charge.

## Wall QR and captive portal

The supplied QR contains `WIFI:T:WPA;S:RELIV-KIOSK;P:RELIVKIOSK2026;;`. It requests Wi-Fi joining. A QR cannot force every phone to both join Wi-Fi and open a web page; the operating system controls join confirmation and the captive sign-in prompt.

For phones that detect a captive portal, configure the Pi AP as follows, from a local console so reconnecting Wi-Fi does not strand your session:

1. Confirm the existing AP broadcasts `RELIV-KIOSK`, uses the supplied password, assigns addresses on `192.168.50.0/24`, and advertises `192.168.50.1` as DNS. Retain its current working DHCP/AP configuration.
2. Add the contents of `deploy/ads-captive-dnsmasq.conf` to the AP's existing dnsmasq configuration. For NetworkManager shared mode, use `/etc/NetworkManager/dnsmasq-shared.d/reliv-ads.conf` **only after confirming your installed version's shared dnsmasq command loads that directory** (`ps -ef | grep '[d]nsmasq'`). For standalone dnsmasq, use its already-enabled conf directory. Do not start a second DNS/DHCP server.
3. Add `deploy/ads-captive-nginx.conf` to nginx's enabled configuration. Check `sudo nginx -t`, then reload nginx. It targets connectivity-check hostnames only and leaves the normal kiosk site untouched. The optional `ads-local-site.example.conf` documents the SPA fallback if the local site is not yet configured; adjust its root to your deployed frontend directory.
4. Validate dnsmasq with its installed configuration, then reload/reconnect the AP using its existing service manager. Rejoin with a phone. The sign-in prompt should navigate to `/advertise`; otherwise open the printed local address manually. Do not redirect HTTPS or all Internet domains.

Apple describes the join/sign-in prompts at https://support.apple.com/en-us/102554. Android describes captive detection and OS limitations at https://developer.android.com/about/versions/11/features/captive-portal. Private DNS, VPNs, remembered Wi-Fi and scanner applications can change behavior. Google Pay/PhonePe are payment scanners and are not a universal Wi-Fi-join interface; use the phone camera or Wi-Fi scanner for this poster.

## Phone payment and activation

Open the local booking page in a normal phone browser before uploading if the captive sign-in window cannot retain tabs. Upload, review, confirm, then use **Open secure payment**. The phone must have Internet access: turn Wi-Fi off and use mobile data. The page cannot change phone network settings itself. The short-lived encrypted link is retained in the same tab's session storage; no plaintext activation code is saved there.

After successful payment, enter the four-digit code using **Enter ad code** on the kiosk. The code is matched against its signed campaign/media/amount, not whichever customer booked last. Codes are unique among eligible active/recently verified requests. Repeating a verified code returns the original result. A kiosk-wide durable five-failure/15-minute budget prevents changing request IDs/IPs to evade limits; successful codes do not erase earlier failures. The default activation grace is 24 hours after payment-link expiry. Retain unresolved payment media for administrator recovery; do not delete it as an abandoned draft.

## Acceptance on the actual Pi

- Check wall QR joining and sign-in on Android and iPhone; test the printed fallback URL.
- Complete a payment in the configured gateway's test mode. Never use simulated client-side success. Confirm that a second phone's booking cannot steal the first phone's activation.
- Check actual video/audio, touch interruption, speech silence during ads, short-screen keypad scrolling, 5/10/15-second intervals and no-ad fallback.
- Verify inventory, health payment, MQTT dispense acknowledgement and admin auth still work.
- Check startup clock/NTP: offline payment expiry and scheduled ads require a correct Pi clock.

Automated checks cover the code paths; physical Wi-Fi joining, actual display alignment, gateway credentials and hardware dispensing still need this deployment check.
