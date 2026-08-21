/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 SERVICE
 * Purpose: Authoritative cloud-side payment handling for offline Pi V2 QRs.
 *          Decrypts packages, verifies Pi signatures, creates Razorpay orders,
 *          verifies live Razorpay payments, and securely reveals the 4-digit code.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from 'fs';
import path from 'path';
import {
    decryptPackage,
    verifyKioskSignature,
    encryptConfirmationCodeAtRest,
    decryptConfirmationCodeAtRest,
    verifyRazorpayPaymentSignature
} from './paymentV2Crypto.js';
import { initPaymentV2Schema } from './paymentV2Db.js';

export class PaymentV2CloudService {
    constructor({
        db,
        razorpay,
        cloudPrivateKeyPath = process.env.PAYMENT_V2_CLOUD_PRIVATE_KEY_PATH || './payment-v2-cloud-private-key.pem',
        cloudPrivateKey = null,
        kioskPublicKeyPath = process.env.PAYMENT_V2_KIOSK_PUBLIC_KEY_PATH || './payment-v2-kiosk-public-key.pem',
        kioskPublicKeysMap = null,
        codeSecret = process.env.PAYMENT_V2_CODE_ENCRYPTION_SECRET || 'reliv_cloud_code_at_rest_secret_seed',
        ttlMarginMs = 30000 // 30s grace period for clock skew
    } = {}) {
        this.db = db;
        this.razorpay = razorpay;
        this.cloudPrivateKeyPath = cloudPrivateKeyPath;
        this._cloudPrivateKey = cloudPrivateKey;
        this.kioskPublicKeyPath = kioskPublicKeyPath;
        this.kioskPublicKeysMap = kioskPublicKeysMap || {};
        this.codeSecret = codeSecret;
        this.ttlMarginMs = ttlMarginMs;

        if (this.db) {
            initPaymentV2Schema(this.db);
        }
    }

    getCloudPrivateKey() {
        if (this._cloudPrivateKey) {
            return this._cloudPrivateKey;
        }
        if (!this.cloudPrivateKeyPath || !fs.existsSync(this.cloudPrivateKeyPath)) {
            throw new Error(`Cloud RSA private key not found at ${this.cloudPrivateKeyPath}`);
        }
        const key = fs.readFileSync(this.cloudPrivateKeyPath, 'utf8');
        this._cloudPrivateKey = key;
        return key;
    }

    getKioskPublicKey(kioskId) {
        if (this.kioskPublicKeysMap && this.kioskPublicKeysMap[kioskId]) {
            const keyOrPath = this.kioskPublicKeysMap[kioskId];
            if (keyOrPath.includes('BEGIN PUBLIC KEY')) {
                return keyOrPath;
            }
            if (fs.existsSync(keyOrPath)) {
                return fs.readFileSync(keyOrPath, 'utf8');
            }
        }
        if (this.kioskPublicKeyPath && fs.existsSync(this.kioskPublicKeyPath)) {
            return fs.readFileSync(this.kioskPublicKeyPath, 'utf8');
        }
        throw new Error(`Public key not registered for kiosk: ${kioskId}`);
    }

    isConfigured() {
        try {
            const privKey = this.getCloudPrivateKey();
            return Boolean(privKey && this.razorpay);
        } catch {
            return false;
        }
    }

    /**
     * Parse package and create Razorpay order
     *
     * @param {string} packageStr - Base64URL encoded package from QR
     * @returns {Promise<Object>}
     */
    async createOrderFromPackage(packageStr) {
        if (!packageStr || typeof packageStr !== 'string') {
            const err = new Error('Package parameter is required');
            err.code = 'INVALID_PACKAGE';
            throw err;
        }

        // 1. Decrypt hybrid package
        const cloudPrivateKey = this.getCloudPrivateKey();
        let decrypted;
        try {
            decrypted = decryptPackage(packageStr, cloudPrivateKey);
        } catch (decErr) {
            const err = new Error(`Failed to decrypt payment package: ${decErr.message}`);
            err.code = 'DECRYPTION_FAILED';
            throw err;
        }

        const { payload, signature } = decrypted;

        // 2. Validate payload structure
        if (!payload || payload.v !== 2 || payload.type !== 'RELIV_PAYMENT_REQUEST') {
            const err = new Error('Invalid payment request type or version');
            err.code = 'INVALID_PAYLOAD_STRUCTURE';
            throw err;
        }

        const requiredFields = [
            'kioskId',
            'requestId',
            'requestNonce',
            'sessionId',
            'transactionId',
            'amount',
            'confirmationCode',
            'issuedAt',
            'expiresAt'
        ];
        for (const field of requiredFields) {
            if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
                const err = new Error(`Payment request payload missing required field: ${field}`);
                err.code = 'MISSING_PAYLOAD_FIELD';
                throw err;
            }
        }

        // 3. Validate confirmation code format strictly
        if (!/^\d{4}$/.test(String(payload.confirmationCode))) {
            const err = new Error('Invalid confirmation code format in payload');
            err.code = 'INVALID_CONFIRMATION_CODE_FORMAT';
            throw err;
        }

        // 4. Verify Ed25519 Kiosk Signature
        const kioskPublicKey = this.getKioskPublicKey(payload.kioskId);
        const isValidSignature = verifyKioskSignature(payload, signature, kioskPublicKey);
        if (!isValidSignature) {
            console.error(`[PaymentV2Cloud] ❌ Signature verification failed for kiosk: ${payload.kioskId}, request: ${payload.requestId}`);
            const err = new Error('Kiosk digital signature is invalid or forged');
            err.code = 'INVALID_SIGNATURE';
            throw err;
        }

        // 5. Expiration Check
        const now = Date.now();
        if (now > payload.expiresAt + this.ttlMarginMs) {
            console.warn(`[PaymentV2Cloud] ⚠️ Request expired: ${payload.requestId} (expired at ${payload.expiresAt}, current ${now})`);
            const err = new Error('Payment request has expired. Please refresh the QR on the kiosk.');
            err.code = 'REQUEST_EXPIRED';
            throw err;
        }

        // 6. Validate Amount and Currency
        const authoritativeAmount = Number(payload.amount);
        if (!Number.isInteger(authoritativeAmount) || authoritativeAmount <= 0) {
            const err = new Error('Invalid payment amount');
            err.code = 'INVALID_AMOUNT';
            throw err;
        }

        if (payload.currency && payload.currency !== 'INR') {
            const err = new Error('Unsupported currency. Only INR is supported.');
            err.code = 'UNSUPPORTED_CURRENCY';
            throw err;
        }

        // 7. Check IDEMPOTENCY & Existing Orders
        const existingOrder = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(payload.requestId);

        if (existingOrder) {
            if (existingOrder.status === 'PAID') {
                console.log(`[PaymentV2Cloud] Request ${payload.requestId} is already PAID for order ${existingOrder.order_id}`);
                return {
                    ok: true,
                    paid: true,
                    orderId: existingOrder.order_id,
                    amount: existingOrder.amount,
                    currency: existingOrder.currency,
                    keyId: this.razorpay?.key_id,
                    requestId: existingOrder.request_id,
                    serviceType: existingOrder.service_type
                };
            }

            if (existingOrder.status === 'CREATED') {
                console.log(`[PaymentV2Cloud] Returning existing Razorpay order ${existingOrder.order_id} for request ${payload.requestId} (idempotent)`);
                return {
                    ok: true,
                    orderId: existingOrder.order_id,
                    amount: existingOrder.amount,
                    currency: existingOrder.currency,
                    keyId: this.razorpay?.key_id,
                    requestId: existingOrder.request_id,
                    serviceType: existingOrder.service_type,
                    alreadyCreated: true
                };
            }
        }

        // 8. Replay Protection: Check Nonce Uniqueness
        const replayNonce = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_nonce = ?').get(payload.requestNonce);
        if (replayNonce && replayNonce.request_id !== payload.requestId) {
            console.error(`[PaymentV2Cloud] ❌ Replay attack detected with nonce: ${payload.requestNonce}`);
            const err = new Error('Request nonce replay detected');
            err.code = 'REPLAY_NONCE_DETECTED';
            throw err;
        }

        // 9. Create Authoritative Razorpay Order
        const rzpOrder = await this.razorpay.orders.create({
            amount: authoritativeAmount,
            currency: 'INR',
            receipt: payload.requestId.substring(0, 40),
            notes: {
                requestId: payload.requestId,
                sessionId: payload.sessionId,
                transactionId: payload.transactionId,
                kioskId: payload.kioskId,
                serviceType: payload.serviceType || 'HEALTH_CHECKUP',
                v: '2'
            }
        });

        // 10. Encrypt Confirmation Code At Rest
        const encryptedCode = encryptConfirmationCodeAtRest(payload.confirmationCode, this.codeSecret);

        // 11. Persist Order in SQLite
        this.db.prepare(`
            INSERT INTO payment_v2_orders (
                order_id, request_id, request_nonce, session_id, transaction_id,
                kiosk_id, amount, currency, service_type, encrypted_code,
                status, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, 'CREATED', ?, ?)
        `).run(
            rzpOrder.id,
            payload.requestId,
            payload.requestNonce,
            payload.sessionId,
            payload.transactionId,
            payload.kioskId,
            authoritativeAmount,
            payload.serviceType || 'HEALTH_CHECKUP',
            encryptedCode,
            now,
            payload.expiresAt
        );

        console.log(`[PaymentV2Cloud] ✅ Created Razorpay order ${rzpOrder.id} for request ${payload.requestId} (₹${authoritativeAmount / 100})`);

        // Return order info (NEVER expose confirmationCode here)
        return {
            ok: true,
            orderId: rzpOrder.id,
            amount: authoritativeAmount,
            currency: 'INR',
            keyId: this.razorpay?.key_id,
            requestId: payload.requestId,
            serviceType: payload.serviceType || 'HEALTH_CHECKUP'
        };
    }

    /**
     * Verify payment with Razorpay and reveal the 4-digit confirmation code
     *
     * @param {Object} params
     * @param {string} params.orderId - Razorpay order ID
     * @param {string} params.paymentId - Razorpay payment ID
     * @param {string} params.signature - Razorpay payment signature
     * @param {string} [params.requestId] - Optional request ID check
     * @returns {Promise<Object>}
     */
    async verifyPaymentAndRevealCode({ orderId, paymentId, signature, requestId = null }) {
        if (!orderId || !paymentId || !signature) {
            const err = new Error('orderId, paymentId, and signature are required');
            err.code = 'MISSING_PARAMS';
            throw err;
        }

        // 1. Fetch order from DB
        const order = this.db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(orderId);
        if (!order) {
            const err = new Error(`Order ${orderId} not found`);
            err.code = 'ORDER_NOT_FOUND';
            throw err;
        }

        if (requestId && order.request_id !== requestId) {
            const err = new Error('Request ID mismatch with order');
            err.code = 'REQUEST_ID_MISMATCH';
            throw err;
        }

        // 2. Check if already PAID (Idempotent Code Reveal)
        if (order.status === 'PAID') {
            if (order.razorpay_payment_id && order.razorpay_payment_id !== paymentId) {
                console.warn(`[PaymentV2Cloud] ⚠️ Order ${orderId} was paid with ${order.razorpay_payment_id}, received ${paymentId}`);
                const err = new Error('Order already paid with different payment ID');
                err.code = 'ORDER_ALREADY_PAID_DIFFERENT_PAYMENT';
                throw err;
            }

            const code = decryptConfirmationCodeAtRest(order.encrypted_code, this.codeSecret);
            console.log(`[PaymentV2Cloud] Re-revealing code for already paid order ${orderId} (idempotent)`);
            return {
                ok: true,
                paid: true,
                alreadyVerified: true,
                confirmationCode: code,
                requestId: order.request_id,
                amount: order.amount,
                currency: order.currency
            };
        }

        // 3. Cryptographically verify Razorpay signature
        const isValidSig = verifyRazorpayPaymentSignature(
            orderId,
            paymentId,
            signature,
            this.razorpay.key_secret
        );

        if (!isValidSig) {
            console.error(`[PaymentV2Cloud] ❌ Invalid Razorpay signature for order ${orderId}, payment ${paymentId}`);
            const err = new Error('Invalid payment signature');
            err.code = 'INVALID_PAYMENT_SIGNATURE';
            throw err;
        }

        // 4. Verify Live Payment with Razorpay API
        let payment;
        try {
            payment = await this.razorpay.payments.fetch(paymentId);
        } catch (fetchErr) {
            console.error(`[PaymentV2Cloud] ❌ Razorpay payment fetch failed: ${fetchErr.message}`);
            const err = new Error(`Failed to fetch payment status from Razorpay: ${fetchErr.message}`);
            err.code = 'RAZORPAY_FETCH_FAILED';
            throw err;
        }

        // 5. Strict Payment Attribute Checks
        if (payment.status !== 'captured' && payment.status !== 'authorized') {
            console.error(`[PaymentV2Cloud] ❌ Payment ${paymentId} not successful. Status: ${payment.status}`);
            const err = new Error(`Payment is not captured. Current status: ${payment.status}`);
            err.code = 'PAYMENT_NOT_CAPTURED';
            throw err;
        }

        if (payment.amount !== order.amount) {
            console.error(`[PaymentV2Cloud] ❌ Payment amount mismatch: paid ₹${payment.amount / 100}, expected ₹${order.amount / 100}`);
            const err = new Error(`Payment amount mismatch. Paid ₹${payment.amount / 100}, expected ₹${order.amount / 100}`);
            err.code = 'AMOUNT_MISMATCH';
            throw err;
        }

        if (payment.order_id !== order.order_id) {
            console.error(`[PaymentV2Cloud] ❌ Payment order ID mismatch: payment order ${payment.order_id} != order ${order.order_id}`);
            const err = new Error('Payment does not match this order ID');
            err.code = 'ORDER_ID_MISMATCH';
            throw err;
        }

        if (payment.currency !== 'INR') {
            const err = new Error(`Payment currency mismatch: ${payment.currency}`);
            err.code = 'CURRENCY_MISMATCH';
            throw err;
        }

        // 6. Atomic DB Status Transition to PAID
        const now = Date.now();
        const updateRes = this.db.prepare(`
            UPDATE payment_v2_orders
            SET status = 'PAID',
                razorpay_payment_id = ?,
                verified_at = ?
            WHERE order_id = ? AND status = 'CREATED'
        `).run(paymentId, now, orderId);

        if (updateRes.changes === 0) {
            // Concurrent request already marked PAID
            console.log(`[PaymentV2Cloud] Order ${orderId} was updated concurrently`);
        }

        // 7. Decrypt and Reveal Confirmation Code ONLY AFTER verified payment
        const confirmationCode = decryptConfirmationCodeAtRest(order.encrypted_code, this.codeSecret);
        console.log(`[PaymentV2Cloud] ✅ Payment verified and code unlocked for order ${orderId}, request ${order.request_id}`);

        return {
            ok: true,
            paid: true,
            alreadyVerified: false,
            confirmationCode,
            requestId: order.request_id,
            amount: order.amount,
            currency: order.currency
        };
    }

    /**
     * Get order status
     * @param {string} orderId
     * @returns {Object}
     */
    getOrderStatus(orderId) {
        if (!orderId) {
            throw new Error('orderId is required');
        }
        const order = this.db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(orderId);
        if (!order) {
            return { ok: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
        }

        return {
            ok: true,
            orderId: order.order_id,
            requestId: order.request_id,
            status: order.status,
            amount: order.amount,
            currency: order.currency,
            expiresAt: order.expires_at,
            paid: order.status === 'PAID'
        };
    }
}

export default PaymentV2CloudService;
