# Fresh payment QR rejected as expired

The Pi signs issuedAt and expiresAt using its system clock. Oracle compares expiresAt with its own clock. If the offline Pi clock is behind, every newly generated QR can already be expired on Oracle. This cannot be repaired by refreshing the QR or relaxing replay protection. A stale QR also expires normally; the error alone does not prove clock drift.

The bridge now validates timestamps, reports future-clock errors, and supplies the kiosk's signed creation/expiry time and server time with expired requests. Paid recovery still requires the exact signed payload and fingerprint and remains accessible after expiry. Invalid local payment lifetimes fail with a clear configuration error; PAYMENT_V2_TTL_SECONDS must be 60–1800 seconds, normally 300.

On the Pi run:

    date -u
    timedatectl status

Compare UTC with a correctly synchronized phone/computer. Check Oracle's UTC too. If wrong, staff can temporarily provide Internet and enable time synchronization with `sudo timedatectl set-ntp true` if the installed time service supports it. Verify `date -u` is correct before disconnecting. For an entirely offline repair, staff must set the verified current UTC date/time manually (`sudo timedatectl set-ntp false`, then `sudo timedatectl set-time 'YYYY-MM-DD HH:MM:SS UTC'` with actual values); never paste a stale example timestamp. Restore the normal synchronization setting when Internet is available. A working RTC/backup supply is needed to retain reliable time through long power loss; software alone cannot discover current UTC without a trusted time source.

After correction, start a new kiosk session and generate a fresh QR. Do not reset or delete the payment database or reuse old activation codes. For a charged order use payment recovery and reconcile its receipt; do not ask the customer to pay again.

Deploy the bridge error changes on Oracle and the TTL validation on the Pi. Frontend handles the legacy REQUEST_EXPIRED response too and keys payment attempts using the same URL-first package selection as the payment request. No clock was changed remotely and no Pi, real payment or physical RTC test was performed.
