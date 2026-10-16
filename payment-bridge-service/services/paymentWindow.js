export function checkPaymentWindow(payload, now, marginMs = 30000, alreadyPaid = false) {
    const { issuedAt, expiresAt } = payload;
    const valid = Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) &&
        issuedAt > 0 && expiresAt > issuedAt && expiresAt <= 8640000000000000;
    if (!valid) {
        throw Object.assign(new Error('The kiosk generated an invalid payment validity period. Ask staff to check its payment settings and clock.'), { code: 'INVALID_PAYMENT_WINDOW' });
    }
    if (alreadyPaid) return;
    const details = { requestId: payload.requestId, kioskId: payload.kioskId,
        kioskIssuedAt: issuedAt, kioskExpiresAt: expiresAt, serverNow: now };
    if (issuedAt > now + marginMs) {
        throw Object.assign(new Error('The kiosk clock is ahead of the payment server. Ask staff to correct the kiosk date and time, then create a new payment QR. Do not pay again if money was deducted.'), {code:'KIOSK_CLOCK_AHEAD', paymentTiming: details});
    }
    if (now > expiresAt + marginMs) {
        throw Object.assign(new Error('This payment QR has expired. If you scanned a newly generated QR immediately, ask staff to check the kiosk date and time: its clock may be behind. Repeated refreshing will not correct the clock. If money was deducted, use payment recovery; do not pay again. Kiosk QR created: ' + new Date(issuedAt).toISOString() + '. Payment server time: ' + new Date(now).toISOString() + '.'), {code:'REQUEST_EXPIRED',paymentTiming:details});
    }
}
