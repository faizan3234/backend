# Fresh payment QR rejected as expired

The Pi signs issuedAt and expiresAt using its system clock. Oracle compares expiresAt with its own clock. If the offline Pi clock is behind, every newly generated QR can already be expired on Oracle. This cannot be repaired by refreshing the QR or relaxing replay protection. A stale QR also expires normally; the error alone does not prove clock drift.

The bridge now validates timestamps, reports future-clock errors, and supplies the kiosk's signed creation/expiry time and server time with expired requests. Paid recovery still requires the exact signed payload and fingerprint and remains accessible after expiry. Invalid local payment lifetimes fail with a clear configuration error; PAYMENT_V2_TTL_SECONDS must be 60–1800 seconds, normally 300.

On the Pi run:

    date -u
    timedatectl status

Compare UTC with a correctly synchronized phone/computer. Check Oracle's UTC too. If wrong, staff can temporarily provide Internet and enable time synchronization with `sudo timedatectl set-ntp true` if the installed time service supports it. Verify `date -u` is correct before disconnecting. For an entirely offline repair, staff must set the verified current UTC date/time manually (`sudo timedatectl set-ntp false`, then `sudo timedatectl set-time 'YYYY-MM-DD HH:MM:SS UTC'` with actual values); never paste a stale example timestamp. Restore the normal synchronization setting when Internet is available. A working RTC/backup supply is needed to retain reliable time through long power loss; software alone cannot discover current UTC without a trusted time source.

After correction, start a new kiosk session and generate a fresh QR. Do not reset or delete the payment database or reuse old activation codes. For a charged order use payment recovery and reconcile its receipt; do not ask the customer to pay again.

Deploy the bridge error changes on Oracle and the TTL validation on the Pi. Frontend handles the legacy REQUEST_EXPIRED response too and keys payment attempts using the same URL-first package selection as the payment request. No clock was changed remotely and no Pi, real payment or physical RTC test was performed.

## Pi repair command and power-loss verification

The two October 17 screenshots show QR creation at 18:27:53Z / 18:31:06Z and cloud receipt at 22:48:14Z / 22:51:42Z. These are about 4h20 apart; freshly generated QRs strongly indicate a behind Pi clock. They do not prove whether the cause is a missing/dead RTC battery, boot configuration, or a manual clock change. Compare actual Pi and Oracle UTC before attributing the hardware cause.

Finish customer operations first. Temporarily give the Pi Internet (phone hotspot/USB tethering/Ethernet). After pulling this change:

    cd ~/backend
    sudo python3 deploy/repair-payment-clock.py --sync --idle-confirmed

This enables the installed NTP service and waits up to 60 seconds for reported synchronization, then writes UTC to RTC. Failure never writes an unsynchronized clock to RTC. It does not change Wi-Fi, firewall, payment secrets or databases. If system time is corrected but RTC write fails, the command reports that persistence is not fixed.

For offline-only repair, check current UTC against a trusted clock and use:

    sudo python3 deploy/repair-payment-clock.py --set-utc 'YYYY-MM-DD HH:MM:SS' --idle-confirmed

Replace the placeholder with the actual current UTC, not IST or the screenshot timestamp. This disables NTP for manual setting; re-enable NTP when Internet is next available. Incorrect operator input creates an incorrect clock.

Then reconnect the kiosk AP if needed, restart the backend with its normal launcher and create a new session/QR. Already captured payments must use recovery, not another charge.

Pi 5 has an RTC; use a suitable backup battery to keep time through complete removal of power. No battery-charging settings are changed by this tool. Official reference: https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#real-time-clock-rtc

**Required physical test:** shut the Pi down safely, disconnect power for several minutes, reconnect with Internet unavailable, then run:

    sudo python3 ~/backend/deploy/repair-payment-clock.py

Compare UTC against the phone. Confirm it advanced through the outage; compare again after an overnight shutdown. Only then generate and scan a fresh QR. If time is lost, inspect the RTC battery/connection and boot time configuration. Matching RTC and system values alone does not prove either is correct.

The code keeps expiry and replay checks intact. Neither physical RTC retention nor a real payment has been tested remotely.

