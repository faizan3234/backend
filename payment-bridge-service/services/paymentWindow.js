export function validateKioskPaymentWindow(payload) {
    const { issuedAt, expiresAt } = payload;
    const valid = Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
        issuedAt > 0 && expiresAt > issuedAt && expiresAt <= 8640000000000000;
    if (!valid) {
        throw Object.assign(
            new Error('The kiosk generated an invalid payment validity period. Ask staff to check its payment settings and clock.'),
            { code: 'INVALID_PAYMENT_WINDOW' }
        );
    }
    const durationMs = expiresAt - issuedAt;
    // Bounds check: 30 seconds to 1 hour
    if (durationMs < 30000 || durationMs > 3600000) {
        throw Object.assign(
            new Error('The kiosk payment duration is out of allowed bounds (30s to 1 hour).'),
            { code: 'INVALID_PAYMENT_WINDOW' }
        );
    }
    return { durationMs };
}

export function checkPaymentWindow(payload, now, marginMs = 30000, alreadyPaid = false, options = {}) {
    validateKioskPaymentWindow(payload);
    if (alreadyPaid) return;

    const details = {
        requestId: payload.requestId,
        kioskId: payload.kioskId,
        kioskIssuedAt: payload.issuedAt,
        kioskExpiresAt: payload.expiresAt,
        serverNow: now,
        ...(options.serverExpiresAt ? { serverExpiresAt: options.serverExpiresAt } : {})
    };

    // If authoritative server expiration is supplied (for existing created orders in DB):
    if (options.serverExpiresAt !== undefined && options.serverExpiresAt !== null) {
        if (now > options.serverExpiresAt + marginMs) {
            throw Object.assign(
                new Error(
                    'This payment QR has expired. If you scanned a newly generated QR immediately, ask staff to check the kiosk date and time: its clock may be behind. Repeated refreshing will not correct the clock. If money was deducted, use payment recovery; do not pay again. Kiosk QR created: ' +
                    new Date(payload.issuedAt).toISOString() + '. Payment server time: ' + new Date(now).toISOString() + '.'
                ),
                { code: 'REQUEST_EXPIRED', paymentTiming: details }
            );
        }
        return;
    }

    // Strict kiosk clock mode (opt-in for explicit legacy verification)
    if (options.strictKioskClock) {
        if (payload.issuedAt > now + marginMs) {
            throw Object.assign(
                new Error('The kiosk clock is ahead of the payment server. Ask staff to correct the kiosk date and time, then create a new payment QR. Do not pay again if money was deducted.'),
                { code: 'KIOSK_CLOCK_AHEAD', paymentTiming: details }
            );
        }
        if (now > payload.expiresAt + marginMs) {
            throw Object.assign(
                new Error(
                    'This payment QR has expired. If you scanned a newly generated QR immediately, ask staff to check the kiosk date and time: its clock may be behind. Repeated refreshing will not correct the clock. If money was deducted, use payment recovery; do not pay again. Kiosk QR created: ' +
                    new Date(payload.issuedAt).toISOString() + '. Payment server time: ' + new Date(now).toISOString() + '.'
                ),
                { code: 'REQUEST_EXPIRED', paymentTiming: details }
            );
        }
    }

    // Default resilient mode for offline kiosk first-time presentations:
    // Offline kiosks without RTC battery drift relative to real wall clock.
    // The payment backend determines validity independently of the Raspberry Pi clock,
    // establishing an authoritative server window upon presentation so fresh QRs never expire.
}
