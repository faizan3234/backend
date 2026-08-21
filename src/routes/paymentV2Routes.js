/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - PAYMENT V2 ROUTES
 * Purpose: Session-scoped endpoints for offline Payment Transport V2
 * ═══════════════════════════════════════════════════════════════════════════
 */

import express from 'express';
import paymentV2ServiceInstance from '../services/paymentV2Service.js';

export function createPaymentV2Router(paymentV2Service = paymentV2ServiceInstance) {
    const router = express.Router({ mergeParams: true });

    /**
     * POST /api/sessions/:sessionId/payment-v2/request
     * Create or retrieve active Payment V2 QR/URL package for this session
     */
    router.post('/request', async (req, res) => {
        try {
            const { sessionId } = req.params;
            const { serviceType, cart } = req.body || {};

            const result = await paymentV2Service.createPaymentRequest(sessionId, {
                serviceType,
                cart
            });

            return res.json(result);

        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error creating payment request:', err.message);

            if (err.code === 'PAYMENT_V2_NOT_CONFIGURED') {
                return res.status(503).json({
                    ok: false,
                    code: 'PAYMENT_V2_NOT_CONFIGURED',
                    message: 'Payment V2 is not configured on this kiosk.'
                });
            }

            return res.status(400).json({
                ok: false,
                code: err.code || 'PAYMENT_REQUEST_FAILED',
                message: err.message || 'Failed to create payment request'
            });
        }
    });

    /**
     * GET /api/sessions/:sessionId/payment-v2/status
     * Retrieve status of payment V2 for this session
     */
    router.get('/status', (req, res) => {
        try {
            const { sessionId } = req.params;
            const status = paymentV2Service.getPaymentStatus(sessionId);
            return res.json(status);
        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error fetching payment status:', err.message);
            return res.status(500).json({
                ok: false,
                code: 'STATUS_FETCH_FAILED',
                message: err.message || 'Failed to fetch payment status'
            });
        }
    });

    /**
     * POST /api/sessions/:sessionId/payment-v2/confirm-code
     * Verify customer-entered 4-digit confirmation code
     */
    router.post('/confirm-code', async (req, res) => {
        try {
            const { sessionId } = req.params;
            const { requestId, code } = req.body || {};

            if (!code) {
                return res.status(400).json({
                    ok: false,
                    code: 'MISSING_CODE',
                    message: 'Confirmation code is required'
                });
            }

            const result = await paymentV2Service.verifyConfirmationCode(sessionId, {
                requestId,
                code
            });

            const statusCode = result.ok ? 200 : (result.code === 'LOCKED' ? 423 : 400);
            return res.status(statusCode).json(result);

        } catch (err) {
            console.error('[PaymentV2Routes] ❌ Error confirming payment code:', err.message);

            if (err.code === 'PAYMENT_V2_NOT_CONFIGURED') {
                return res.status(503).json({
                    ok: false,
                    code: 'PAYMENT_V2_NOT_CONFIGURED',
                    message: 'Payment V2 is not configured on this kiosk.'
                });
            }

            return res.status(500).json({
                ok: false,
                code: 'CONFIRMATION_ERROR',
                message: err.message || 'Failed to verify confirmation code'
            });
        }
    });

    return router;
}

export default createPaymentV2Router;
