/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 ROUTES
 * Purpose: Express endpoints for Payment V2 QR decryption, Razorpay order
 *          creation, and verified confirmation code reveal.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import express from 'express';

export function createPaymentV2Router(paymentV2CloudService) {
    const router = express.Router();

    /**
     * POST /v2/create-order
     * Body: { package: string } or raw string in package param
     */
    router.post('/create-order', async (req, res) => {
        try {
            const packageStr = req.body?.package || req.body?.p;
            if (!packageStr) {
                return res.status(400).json({
                    ok: false,
                    code: 'MISSING_PACKAGE',
                    message: 'Encrypted payment package (package or p) is required'
                });
            }

            const result = await paymentV2CloudService.createOrderFromPackage(packageStr);
            return res.json(result);

        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error creating order:', err.message);

            const statusCode = (
                err.code === 'DECRYPTION_FAILED' ||
                err.code === 'INVALID_SIGNATURE' ||
                err.code === 'INVALID_PAYLOAD_STRUCTURE' ||
                err.code === 'REPLAY_NONCE_DETECTED'
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
    router.post('/verify-payment', async (req, res) => {
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
                err.code === 'INVALID_PAYMENT_SIGNATURE' ||
                err.code === 'AMOUNT_MISMATCH' ||
                err.code === 'ORDER_ID_MISMATCH' ||
                err.code === 'ORDER_NOT_FOUND' ||
                err.code === 'REQUEST_ID_MISMATCH'
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
