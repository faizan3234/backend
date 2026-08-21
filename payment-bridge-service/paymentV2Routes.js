/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 ROUTES
 * Purpose: Express endpoints for Payment V2 QR decryption, Razorpay order
 *          creation, and verified confirmation code reveal with rate-limiting
 *          and 16KB package size protection.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import express from 'express';

const MAX_PACKAGE_BYTES = 16384; // 16KB

/**
 * In-memory sliding window rate limiter for V2 endpoints
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window per IP
 */
export function createV2RateLimiter({ windowMs = 60000, max = 60 } = {}) {
    const clients = new Map();

    return (req, res, next) => {
        const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
        const now = Date.now();
        const timestamps = clients.get(ip) || [];
        const validTimestamps = timestamps.filter(t => now - t < windowMs);

        if (validTimestamps.length >= max) {
            console.warn(`[PaymentV2RateLimit] ⚠️ Rate limit exceeded for IP: ${ip}`);
            return res.status(429).json({
                ok: false,
                code: 'RATE_LIMIT_EXCEEDED',
                message: 'Too many requests. Please try again later.'
            });
        }

        validTimestamps.push(now);
        clients.set(ip, validTimestamps);

        // Periodically prune stale clients
        if (clients.size > 1000) {
            for (const [key, list] of clients.entries()) {
                if (list.every(t => now - t >= windowMs)) {
                    clients.delete(key);
                }
            }
        }

        next();
    };
}

export function createPaymentV2Router(paymentV2CloudService, {
    createOrderLimiter = createV2RateLimiter({ windowMs: 60000, max: 60 }),
    verifyPaymentLimiter = createV2RateLimiter({ windowMs: 60000, max: 30 })
} = {}) {
    const router = express.Router();

    /**
     * POST /v2/create-order
     * Body: { package: string } or raw string in package param
     */
    router.post('/create-order', createOrderLimiter, async (req, res) => {
        try {
            const packageStr = req.body?.package || req.body?.p;
            if (!packageStr) {
                return res.status(400).json({
                    ok: false,
                    code: 'MISSING_PACKAGE',
                    message: 'Encrypted payment package (package or p) is required'
                });
            }

            // Enforce 16KB maximum package size limit
            const byteLength = Buffer.byteLength(String(packageStr), 'utf8');
            if (byteLength > MAX_PACKAGE_BYTES) {
                console.warn(`[PaymentV2Routes] ⚠️ Package size ${byteLength} bytes exceeds 16KB limit`);
                return res.status(413).json({
                    ok: false,
                    code: 'PACKAGE_TOO_LARGE',
                    message: `Payment package size (${byteLength} bytes) exceeds maximum allowed limit of 16KB`
                });
            }

            const result = await paymentV2CloudService.createOrderFromPackage(packageStr);
            return res.json(result);

        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error creating order:', err.message);

            const statusCode = (
                err.code === 'PAYMENT_V2_NOT_CONFIGURED'
            ) ? 503 : (
                err.code === 'DECRYPTION_FAILED' ||
                err.code === 'INVALID_SIGNATURE' ||
                err.code === 'INVALID_PAYLOAD_STRUCTURE' ||
                err.code === 'REPLAY_NONCE_DETECTED' ||
                err.code === 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH'
            ) ? 400 : (err.code === 'REQUEST_EXPIRED' ? 410 : 500);

            return res.status(statusCode).json({
                ok: false,
                code: err.code || 'CREATE_ORDER_FAILED',
                message: err.message || 'Failed to create payment order'
            });
        }
    });

    /**
     * POST /v2/verify-payment
     * Body: { orderId, paymentId, signature, requestId? }
     */
    router.post('/verify-payment', verifyPaymentLimiter, async (req, res) => {
        try {
            const { orderId, paymentId, signature, requestId } = req.body || {};

            if (!orderId || !paymentId || !signature) {
                return res.status(400).json({
                    ok: false,
                    code: 'MISSING_PAYMENT_PROOF',
                    message: 'orderId, paymentId, and signature are required'
                });
            }

            const result = await paymentV2CloudService.verifyPaymentAndRevealCode({
                orderId,
                paymentId,
                signature,
                requestId
            });

            return res.json(result);

        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error verifying payment:', err.message);

            const statusCode = (
                err.code === 'PAYMENT_V2_NOT_CONFIGURED'
            ) ? 503 : (
                err.code === 'INVALID_PAYMENT_SIGNATURE' ||
                err.code === 'AMOUNT_MISMATCH' ||
                err.code === 'ORDER_ID_MISMATCH' ||
                err.code === 'ORDER_NOT_FOUND' ||
                err.code === 'REQUEST_ID_MISMATCH' ||
                err.code === 'PAYMENT_ID_ALREADY_USED' ||
                err.code === 'PAYMENT_NOT_CAPTURED'
            ) ? 400 : 500;

            return res.status(statusCode).json({
                ok: false,
                code: err.code || 'PAYMENT_VERIFICATION_FAILED',
                message: err.message || 'Payment verification failed'
            });
        }
    });

    /**
     * GET /v2/order/:orderId/status
     */
    router.get('/order/:orderId/status', (req, res) => {
        try {
            const { orderId } = req.params;
            const status = paymentV2CloudService.getOrderStatus(orderId);
            return res.json(status);
        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error getting order status:', err.message);
            return res.status(500).json({
                ok: false,
                code: 'STATUS_FETCH_FAILED',
                message: err.message || 'Failed to fetch order status'
            });
        }
    });

    return router;
}

export default createPaymentV2Router;
