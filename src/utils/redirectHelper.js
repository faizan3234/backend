/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - REDIRECT HELPER
 * Purpose: Safe returnUrl allowlist validation & 302 URL parameter building
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Validate and sanitize returnUrl to prevent open redirect vulnerabilities.
 * Append or update query parameters cleanly while excluding sensitive state.
 *
 * @param {string} rawReturnUrl - Raw returnUrl parameter from request
 * @param {Object} queryParams - Key-value map of parameters to append to URL
 * @returns {string} Sanitized redirect URL string
 */
export function buildValidatedRedirectUrl(rawReturnUrl, queryParams = {}) {
    const DEFAULT_CUSTOMER_SITE = 'https://customer.reliv.in/kiosk';
    
    let targetUrl;
    try {
        if (rawReturnUrl && typeof rawReturnUrl === 'string' && rawReturnUrl.trim().length > 0) {
            // Support relative URLs or full URLs
            if (rawReturnUrl.startsWith('/')) {
                targetUrl = new URL(rawReturnUrl, DEFAULT_CUSTOMER_SITE);
            } else {
                targetUrl = new URL(rawReturnUrl);
            }
            
            const allowedHosts = [
                'customer.reliv.in',
                'reliv.in',
                'localhost',
                '127.0.0.1',
                '192.168.50.1'
            ];
            
            const hostname = targetUrl.hostname.toLowerCase();
            const isAllowed = allowedHosts.some(host => hostname === host || hostname.endsWith('.' + host));
            
            if (!isAllowed) {
                console.warn(`[ReturnUrl] Host '${hostname}' not in allowlist. Falling back to default: ${DEFAULT_CUSTOMER_SITE}`);
                targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
            }
        } else {
            targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
        }
    } catch (err) {
        console.warn(`[ReturnUrl] Invalid returnUrl '${rawReturnUrl}'. Falling back to default: ${DEFAULT_CUSTOMER_SITE}`);
        targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
    }
    
    // Append or set safe query parameters
    for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null && value !== '') {
            targetUrl.searchParams.set(key, String(value));
        }
    }
    
    return targetUrl.toString();
}
