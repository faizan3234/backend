// Provider diagnostics belong in server logs, never in the customer response.
export function emailFailure(cause) {
    const auth = cause?.code === 'EAUTH' || Number(cause?.responseCode) === 535 ||
        /535[ -]|badcredentials|invalid login/i.test(cause?.message || '');
    const error = new Error(auth
        ? 'Our email sender needs an administrator to reconnect it. Your payment remains recorded; do not pay again. You can retry delivery after it is restored.'
        : 'Email delivery is temporarily unavailable. Your payment remains recorded; do not pay again. Please retry delivery shortly.');
    error.code = auth ? 'EMAIL_AUTH_FAILED' : 'EMAIL_SEND_FAILED';
    return error;
}
