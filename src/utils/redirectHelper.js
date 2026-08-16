/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - REDIRECT HELPER
 * Purpose: Strict HTTPS returnUrl allowlist validation & 302 parameter building
 *
 * Allowlist resolution order:
 *  1. Hardcoded production baseline  — always allowed (*.reliv.in over HTTPS)
 *  2. ALLOWED_RETURN_ORIGINS env var — comma-separated extra origins
 *  3. Dev mode                       — localhost / 127.0.0.1 when
 *                                      NODE_ENV=development|test
 *  4. Blocked always                 — http://192.168.50.1 and any plain HTTP
 *                                      origin not covered by dev mode
 *
 * To add a staging domain without a code deploy, set on the Pi:
 *   ALLOWED_RETURN_ORIGINS=https://reliv7.vercel.app,https://staging.reliv.in
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Parse ALLOWED_RETURN_ORIGINS env var into a Set of lowercase origin strings.
 * Called once at module load so the regex work is not repeated per-request.
 *
 * @returns {Set<string>}
 */
function parseAllowedOrigins() {
    const raw = process.env.ALLOWED_RETURN_ORIGINS || '';
    const extra = raw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

    // Production staging default — always included so the Pi works out-of-the-box
    // without requiring an explicit env entry for the current staging domain.
    const stagingDefaults = [
        'https://reliv7.vercel.app'
    ];

    return new Set([...stagingDefaults, ...extra]);
}

// Build once at startup.
const EXTRA_ALLOWED_ORIGINS = parseAllowedOrigins();

/**
 * Decide whether a parsed URL is permitted as a redirect destination.
 *
 * @param {URL} url
 * @returns {boolean}
 */
function isAllowedOrigin(url) {
    const hostname = url.hostname.toLowerCase();
    const protocol = url.protocol.toLowerCase();
    const origin   = url.origin.toLowerCase();

    // ── 1. Hardcoded production baseline (*.reliv.in over HTTPS) ────────────
    const isRelivDomain =
        protocol === 'https:' &&
        (hostname === 'reliv.in' ||
         hostname === 'customer.reliv.in' ||
         hostname.endsWith('.reliv.in'));

    if (isRelivDomain) return true;

    // ── 2. Env-driven extra origins ─────────────────────────────────────────
    if (EXTRA_ALLOWED_ORIGINS.has(origin)) return true;

    // ── 3. Dev mode — localhost only ─────────────────────────────────────────
    const isDevMode =
        process.env.NODE_ENV === 'development' ||
        process.env.NODE_ENV === 'test';

    const isLocalhost =
        hostname === 'localhost' || hostname === '127.0.0.1';

    if (isDevMode && isLocalhost) return true;

    // ── 4. Everything else — blocked ─────────────────────────────────────────
    return false;
}

/**
 * Validate and sanitize returnUrl to prevent open redirect vulnerabilities,
 * then append the supplied query parameters.
 *
 * @param {string}  rawReturnUrl - Raw returnUrl parameter from the HTTP request
 * @param {Object}  queryParams  - Key-value map of parameters to append
 * @returns {string} Sanitized, fully-qualified redirect URL string
 */
export function buildValidatedRedirectUrl(rawReturnUrl, queryParams = {}) {
    const DEFAULT_CUSTOMER_SITE = 'https://customer.reliv.in/kiosk';

    let targetUrl;
    try {
        if (rawReturnUrl && typeof rawReturnUrl === 'string' && rawReturnUrl.trim().length > 0) {
            // Support relative paths as well as absolute URLs.
            if (rawReturnUrl.startsWith('/')) {
                targetUrl = new URL(rawReturnUrl, DEFAULT_CUSTOMER_SITE);
            } else {
                targetUrl = new URL(rawReturnUrl);
            }

            // Explicitly reject the Pi AP address — it must never be a customer
            // redirect destination regardless of any other rule.
            if (targetUrl.hostname === '192.168.50.1') {
                console.warn(`[ReturnUrl] Pi AP address rejected as returnUrl destination. Falling back to default.`);
                targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
            } else if (!isAllowedOrigin(targetUrl)) {
                console.warn(
                    `[ReturnUrl] Origin '${targetUrl.origin}' not in allowlist. ` +
                    `Falling back to default: ${DEFAULT_CUSTOMER_SITE}. ` +
                    `Set ALLOWED_RETURN_ORIGINS env var to add extra origins.`
                );
                targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
            }
        } else {
            targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
        }
    } catch (err) {
        console.warn(`[ReturnUrl] Invalid returnUrl '${rawReturnUrl}'. Falling back to default: ${DEFAULT_CUSTOMER_SITE}`);
        targetUrl = new URL(DEFAULT_CUSTOMER_SITE);
    }

    // Append query parameters, skipping nullish/empty values.
    for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined && value !== null && value !== '') {
            targetUrl.searchParams.set(key, String(value));
        }
    }

    return targetUrl.toString();
}
