/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - REDIRECT HELPER
 * Purpose: Strict HTTPS returnUrl allowlist validation & 302 parameter building
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Validate and sanitize returnUrl to prevent open redirect vulnerabilities.
 * Restricts target origin strictly to the production HTTPS customer website.
 * Rejects local IP/AP addresses like http://192.168.50.1 as returnUrl destinations.
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
            // Support relative paths or absolute URLs
            if (rawReturnUrl.startsWith('/')) {
                targetUrl = new URL(rawReturnUrl, DEFAULT_CUSTOMER_SITE);
            } else {
                targetUrl = new URL(rawReturnUrl);
            }
            
            const hostname = targetUrl.hostname.toLowerCase();
            const protocol = targetUrl.protocol.toLowerCase();
            
            // Production rule: Must be HTTPS customer domain (customer.reliv.in or reliv.in subdomains)
            const isProdCustomerDomain = (hostname === 'customer.reliv.in' || hostname === 'reliv.in' || hostname.endsWith('.reliv.in')) && protocol === 'https:';
            
            // Optional development override for local testing
            const isDevMode = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
            const isDevAllowed = isDevMode && (hostname === 'localhost' || hostname === '127.0.0.1');
            
            // Explicitly reject http://192.168.50.1 as a returnUrl destination
            if (hostname === '192.168.50.1' || (protocol === 'http:' && !isDevAllowed)) {
                console.warn(`[ReturnUrl] Disallowed protocol/host '${targetUrl.origin}'. Falling back to default: ${DEFAULT_CUSTOMER_SITE}`);
                targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
            } else if (!isProdCustomerDomain && !isDevAllowed) {
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
