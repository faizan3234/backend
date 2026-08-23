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
    computePayloadFingerprint,
    encryptConfirmationCodeAtRest,
    decryptConfirmationCodeAtRest,
    verifyRazorpayPaymentSignature
} from './paymentV2Crypto.js';
import { initPaymentV2Schema } from './paymentV2Db.js';
import { sendPaymentReceipt } from './services/receiptEmailService.js';

export class PaymentV2CloudService {
    constructor({
        db,
        razorpay,
        cloudPrivateKeyPath = process.env.PAYMENT_V2_CLOUD_PRIVATE_KEY_PATH || './payment-v2-cloud-private-key.pem',
        cloudPrivateKey = null,
        kioskPublicKeyPath = process.env.PAYMENT_V2_KIOSK_PUBLIC_KEY_PATH || './payment-v2-kiosk-public-key.pem',
        kioskPublicKeysMap = null,
        codeSecret = process.env.PAYMENT_V2_CODE_ENCRYPTION_SECRET || '',
        ttlMarginMs = 30000 // 30s grace period for clock skew
    } = {}) {
        this.db = db;
        this.razorpay = razorpay;
        this.cloudPrivateKeyPath = cloudPrivateKeyPath;
        this._cloudPrivateKey = cloudPrivateKey;
        this.kioskPublicKeyPath = kioskPublicKeyPath;
        this.kioskPublicKeysMap = kioskPublicKeysMap || {};
        this.codeSecret = String(codeSecret || '').trim();
        this.ttlMarginMs = ttlMarginMs;
        this._inflightOrders = new Map();

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
        if (!this.codeSecret || !String(this.codeSecret).trim()) {
            return false;
        }
        if (!this.razorpay || !this.razorpay.key_id || !this.razorpay.key_secret) {
            return false;
        }
        try {
            const privKey = this.getCloudPrivateKey();
            if (!privKey || !privKey.includes('PRIVATE KEY')) {
                return false;
            }
            // Verify at least default kiosk public key path exists or keys map has entries
            const hasRegisteredKiosk = Object.keys(this.kioskPublicKeysMap).length > 0 ||
                (Boolean(this.kioskPublicKeyPath) && fs.existsSync(this.kioskPublicKeyPath));
            if (!hasRegisteredKiosk) {
                return false;
            }
            return true;
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
        if (!this.isConfigured()) {
            const err = new Error('Payment V2 is not configured on this bridge. Required keys or secrets missing.');
            err.code = 'PAYMENT_V2_NOT_CONFIGURED';
            throw err;
        }

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

        // 7. Compute Payload Fingerprint (SHA-256)
        const payloadFingerprint = computePayloadFingerprint(payload);

        // 8. Deduplicate concurrent requests for the exact same requestId
        if (this._inflightOrders.has(payload.requestId)) {
            console.log(`[PaymentV2Cloud] Awaiting existing in-flight order creation for request ${payload.requestId}`);
            return await this._inflightOrders.get(payload.requestId);
        }

        const createPromise = (async () => {
            // Check IDEMPOTENCY & Existing Orders
            const existingOrder = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(payload.requestId);

            if (existingOrder) {
                // Check fingerprint mismatch (Tampering / Replay with same requestId but modified payload)
                if (existingOrder.payload_fingerprint && existingOrder.payload_fingerprint !== payloadFingerprint) {
                    console.error(`[PaymentV2Cloud] ❌ Payload fingerprint mismatch for request ${payload.requestId}`);
                    const err = new Error('Payload fingerprint mismatch. Request ID was already bound to a different payload.');
                    err.code = 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH';
                    throw err;
                }

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

            // Replay Protection: Check Nonce Uniqueness
            const replayNonce = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_nonce = ?').get(payload.requestNonce);
            if (replayNonce && replayNonce.request_id !== payload.requestId) {
                console.error(`[PaymentV2Cloud] ❌ Replay attack detected with nonce: ${payload.requestNonce}`);
                const err = new Error('Request nonce replay detected');
                err.code = 'REPLAY_NONCE_DETECTED';
                throw err;
            }

            // Create Authoritative Razorpay Order
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

            // Validate Items Snapshot & Breakdown Integrity if present in signed payload
            let itemsJson = null;
            let breakdownJson = null;

            if (payload.items) {
                if (!Array.isArray(payload.items)) {
                    console.error('[PaymentV2Cloud] ❌ Invalid items payload: not an array');
                    const err = new Error('Invalid items payload structure');
                    err.code = 'INVALID_PAYLOAD_STRUCTURE';
                    throw err;
                }

                for (const it of payload.items) {
                    if (!it || typeof it !== 'object') {
                        const err = new Error('Invalid item structure in payload');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (!it.kitId || typeof it.kitId !== 'string') {
                        const err = new Error('Invalid item kitId in payload');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (!it.name || typeof it.name !== 'string') {
                        const err = new Error('Invalid item name in payload');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
                        const err = new Error('Invalid item quantity in payload: must be positive integer');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (!Number.isInteger(it.unitPricePaise) || it.unitPricePaise < 0) {
                        const err = new Error('Invalid item unitPricePaise in payload');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (!Number.isInteger(it.lineTotalPaise) || it.lineTotalPaise < 0) {
                        const err = new Error('Invalid item lineTotalPaise in payload');
                        err.code = 'INVALID_PAYLOAD_STRUCTURE';
                        throw err;
                    }
                    if (it.lineTotalPaise !== it.unitPricePaise * it.quantity) {
                        console.error(`[PaymentV2Cloud] ❌ Line total mismatch for ${it.name}: ${it.lineTotalPaise} !== ${it.unitPricePaise} * ${it.quantity}`);
                        const err = new Error('Item line total does not equal unitPricePaise * quantity');
                        err.code = 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH';
                        throw err;
                    }
                }

                itemsJson = JSON.stringify(payload.items);
            }

            if (payload.breakdown) {
                const b = payload.breakdown;
                if (!b || typeof b !== 'object') {
                    const err = new Error('Invalid breakdown structure in payload');
                    err.code = 'INVALID_PAYLOAD_STRUCTURE';
                    throw err;
                }
                if (!Number.isInteger(b.totalPaise) || b.totalPaise !== authoritativeAmount) {
                    console.error(`[PaymentV2Cloud] ❌ Breakdown total mismatch: ${b.totalPaise} !== ${authoritativeAmount}`);
                    const err = new Error('Breakdown total does not match authoritative amount');
                    err.code = 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH';
                    throw err;
                }
                breakdownJson = JSON.stringify(b);
            }

            // Encrypt Confirmation Code At Rest
            const encryptedCode = encryptConfirmationCodeAtRest(payload.confirmationCode, this.codeSecret);

            let itemName = payload.itemName || payload.medicineName || payload.item_name || payload.medicine_name || null;
            if (!itemName && payload.items && payload.items.length > 0) {
                itemName = payload.items[0].name;
            }
            let cartJson = null;
            if (payload.cart) {
                try {
                    const parsed = typeof payload.cart === 'string' ? JSON.parse(payload.cart) : payload.cart;
                    cartJson = JSON.stringify(parsed);
                    if (!itemName && Array.isArray(parsed) && parsed.length > 0) {
                        itemName = parsed[0].name || parsed[0].item_name || parsed[0].medicine_name || parsed[0].kit_id || null;
                    }
                } catch (e) {
                    cartJson = typeof payload.cart === 'string' ? payload.cart : JSON.stringify(payload.cart);
                }
            } else if (payload.items) {
                cartJson = JSON.stringify(payload.items.map(it => ({
                    kit_id: it.kitId,
                    name: it.name,
                    quantity: it.quantity,
                    price: it.unitPricePaise / 100,
                    total: it.lineTotalPaise / 100
                })));
            }
            const customerName = payload.customerName || payload.customer_name || null;

            // Persist Order in SQLite
            this.db.prepare(`
                INSERT INTO payment_v2_orders (
                    order_id, request_id, request_nonce, payload_fingerprint,
                    session_id, transaction_id, kiosk_id, amount, currency,
                    service_type, item_name, cart, customer_name,
                    items_json, breakdown_json,
                    encrypted_code, status, created_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?)
            `).run(
                rzpOrder.id,
                payload.requestId,
                payload.requestNonce,
                payloadFingerprint,
                payload.sessionId,
                payload.transactionId,
                payload.kioskId,
                authoritativeAmount,
                payload.serviceType || 'HEALTH_CHECKUP',
                itemName,
                cartJson,
                customerName,
                itemsJson,
                breakdownJson,
                encryptedCode,
                now,
                payload.expiresAt
            );

            console.log(`[PaymentV2Cloud] ✅ Created Razorpay order ${rzpOrder.id} for request ${payload.requestId} (₹${authoritativeAmount / 100})`);

            return {
                ok: true,
                orderId: rzpOrder.id,
                amount: authoritativeAmount,
                currency: 'INR',
                keyId: this.razorpay?.key_id,
                requestId: payload.requestId,
                serviceType: payload.serviceType || 'HEALTH_CHECKUP'
            };
        })();

        this._inflightOrders.set(payload.requestId, createPromise);
        try {
            return await createPromise;
        } finally {
            this._inflightOrders.delete(payload.requestId);
        }
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
        if (!this.isConfigured()) {
            const err = new Error('Payment V2 is not configured on this bridge. Required keys or secrets missing.');
            err.code = 'PAYMENT_V2_NOT_CONFIGURED';
            throw err;
        }

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

        // 5. Strict Payment Attribute Checks: Strictly require 'captured'
        if (payment.status !== 'captured') {
            console.error(`[PaymentV2Cloud] ❌ Payment ${paymentId} not captured. Status: ${payment.status}`);
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

        // 6. Atomic DB Status Transition to PAID with unique payment ID protection
        const now = Date.now();
        try {
            const updateRes = this.db.prepare(`
                UPDATE payment_v2_orders
                SET status = 'PAID',
                    razorpay_payment_id = ?,
                    verified_at = ?
                WHERE order_id = ? AND status = 'CREATED'
            `).run(paymentId, now, orderId);

            if (updateRes.changes === 0) {
                // Check if concurrent request already marked PAID
                const currentOrder = this.db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(orderId);
                if (currentOrder && currentOrder.status === 'PAID' && currentOrder.razorpay_payment_id === paymentId) {
                    const code = decryptConfirmationCodeAtRest(currentOrder.encrypted_code, this.codeSecret);
                    return {
                        ok: true,
                        paid: true,
                        alreadyVerified: true,
                        confirmationCode: code,
                        requestId: currentOrder.request_id,
                        amount: currentOrder.amount,
                        currency: currentOrder.currency
                    };
                }
            }
        } catch (dbErr) {
            if (dbErr.message && dbErr.message.includes('UNIQUE constraint failed')) {
                console.error(`[PaymentV2Cloud] ❌ Replay attempt: Payment ID ${paymentId} already verified on another order`);
                const err = new Error('Payment ID has already been verified for another order');
                err.code = 'PAYMENT_ID_ALREADY_USED';
                throw err;
            }
            throw dbErr;
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

    /**
     * Reconcile / Recover payment status for an authoritative order
     * Handles lost frontend browser callbacks after successful Razorpay checkout.
     *
     * SECURITY RULES:
     * 1. Only requestId is accepted (client amounts/paymentIds/codes are never trusted).
     * 2. If already PAID: returns the existing confirmation code idempotently without second charge/order.
     * 3. If CREATED / PENDING: queries Razorpay API directly using authoritative order_id.
     * 4. Matches captured status, order_id, amount, and currency strictly.
     * 5. Atomically transitions status to PAID and unlocks the 4-digit code.
     *
     * @param {Object} params
     * @param {string} params.requestId
     * @returns {Promise<Object>}
     */
    async recoverPayment({ requestId }) {
        if (!this.isConfigured()) {
            const err = new Error('Payment V2 is not configured on this bridge. Required keys or secrets missing.');
            err.code = 'PAYMENT_V2_NOT_CONFIGURED';
            throw err;
        }

        if (!requestId || typeof requestId !== 'string') {
            const err = new Error('requestId is required');
            err.code = 'MISSING_REQUEST_ID';
            throw err;
        }

        const normalizedRequestId = requestId.trim();

        // 1. Fetch authoritative order from SQLite DB
        const order = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(normalizedRequestId);
        if (!order) {
            console.warn(`[PaymentV2Cloud] ⚠️ Order not found for recovery: ${normalizedRequestId}`);
            const err = new Error(`Order for request ${normalizedRequestId} not found`);
            err.code = 'ORDER_NOT_FOUND';
            throw err;
        }

        // 2. CASE A: Order is already PAID
        if (order.status === 'PAID' && order.razorpay_payment_id) {
            console.log(`[PaymentV2Cloud] ℹ️ Order for request ${normalizedRequestId} is already PAID (${order.order_id}). Returning unlocked code.`);
            const confirmationCode = decryptConfirmationCodeAtRest(order.encrypted_code, this.codeSecret);

            return {
                ok: true,
                paid: true,
                recovered: true,
                alreadyPaid: true,
                status: 'PAID',
                confirmationCode,
                requestId: order.request_id,
                orderId: order.order_id,
                paymentId: order.razorpay_payment_id,
                amount: order.amount,
                currency: order.currency,
                serviceType: order.service_type
            };
        }

        // 3. CASE B: Query Razorpay directly for payments linked to this order_id
        let payments;
        try {
            payments = await this.razorpay.orders.fetchPayments(order.order_id);
        } catch (rzpErr) {
            console.error(`[PaymentV2Cloud] ❌ Razorpay order fetchPayments failed for order ${order.order_id}: ${rzpErr.message}`);
            const err = new Error(`Failed to query Razorpay API for order ${order.order_id}: ${rzpErr.message}`);
            err.code = 'RAZORPAY_FETCH_FAILED';
            throw err;
        }

        const paymentList = Array.isArray(payments) ? payments : (payments?.items || []);

        // Find a valid captured payment matching authoritative order properties
        const capturedPayment = paymentList.find(p => {
            const status = String(p.status || '').toLowerCase();
            const orderIdMatches = p.order_id === order.order_id;
            const amountMatches = Number(p.amount) === Number(order.amount);
            const currencyMatches = String(p.currency || 'INR').toUpperCase() === String(order.currency || 'INR').toUpperCase();
            const isCaptured = status === 'captured' || (status === 'authorized' && p.captured === true);

            return orderIdMatches && amountMatches && currencyMatches && isCaptured;
        });

        if (!capturedPayment) {
            console.log(`[PaymentV2Cloud] ℹ️ No captured payment found for order ${order.order_id} (request: ${normalizedRequestId})`);
            return {
                ok: true,
                paid: false,
                recovered: false,
                status: order.status,
                requestId: order.request_id,
                orderId: order.order_id,
                amount: order.amount,
                currency: order.currency,
                message: 'Payment has not yet been captured or completed'
            };
        }

        // 4. Unique Payment ID Check (Replay Prevention)
        const dupCheck = this.db.prepare('SELECT * FROM payment_v2_orders WHERE razorpay_payment_id = ? AND order_id != ?').get(capturedPayment.id, order.order_id);
        if (dupCheck) {
            console.error(`[PaymentV2Cloud] ❌ Replay prevention: Payment ID ${capturedPayment.id} already bound to order ${dupCheck.order_id}`);
            const err = new Error('Payment ID has already been verified for another order');
            err.code = 'PAYMENT_ID_ALREADY_USED';
            throw err;
        }

        // 5. Atomic DB Status Transition to PAID
        const now = Date.now();
        const updateRes = this.db.prepare(`
            UPDATE payment_v2_orders
            SET status = 'PAID',
                razorpay_payment_id = ?,
                verified_at = ?
            WHERE order_id = ? AND status != 'PAID'
        `).run(capturedPayment.id, now, order.order_id);

        if (updateRes.changes === 0) {
            // Already updated concurrently
            const current = this.db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(order.order_id);
            if (current && current.status === 'PAID') {
                const code = decryptConfirmationCodeAtRest(current.encrypted_code, this.codeSecret);
                return {
                    ok: true,
                    paid: true,
                    recovered: true,
                    alreadyPaid: true,
                    status: 'PAID',
                    confirmationCode: code,
                    requestId: current.request_id,
                    orderId: current.order_id,
                    paymentId: current.razorpay_payment_id,
                    amount: current.amount,
                    currency: current.currency,
                    serviceType: current.service_type
                };
            }
        }

        // 6. Decrypt confirmation code at rest
        const confirmationCode = decryptConfirmationCodeAtRest(order.encrypted_code, this.codeSecret);
        console.log(`[PaymentV2Cloud] ✅ Recovered and verified payment ${capturedPayment.id} for order ${order.order_id}, request ${order.request_id} (Code revealed)`);

        return {
            ok: true,
            paid: true,
            recovered: true,
            newlyVerified: true,
            status: 'PAID',
            confirmationCode,
            requestId: order.request_id,
            orderId: order.order_id,
            paymentId: capturedPayment.id,
            amount: order.amount,
            currency: order.currency,
            serviceType: order.service_type
        };
    }

    /**
     * Send authoritative payment receipt email for a PAID order
     *
     * @param {Object} params
     * @param {string} params.requestId - Request ID (REQ-...)
     * @param {string} params.email - Customer email address
     * @param {import('nodemailer').Transporter} [params.transporterOverride] - Optional transporter
     * @returns {Promise<Object>}
     */
    async sendEmailReceipt({ requestId, email, transporterOverride = null }) {
        if (!requestId || typeof requestId !== 'string') {
            const err = new Error('requestId is required');
            err.code = 'MISSING_REQUEST_ID';
            throw err;
        }

        if (!email || typeof email !== 'string') {
            const err = new Error('email is required');
            err.code = 'MISSING_EMAIL';
            throw err;
        }

        // 1. Fetch order from SQLite database by request_id
        const order = this.db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(requestId);
        if (!order) {
            console.warn(`[PaymentV2Cloud] ⚠️ Order not found for receipt dispatch: ${requestId}`);
            const err = new Error(`Order for request ${requestId} not found`);
            err.code = 'ORDER_NOT_FOUND';
            throw err;
        }

        // 2. Authoritative check: Must be PAID with valid razorpay_payment_id
        if (order.status !== 'PAID' || !order.razorpay_payment_id) {
            console.warn(`[PaymentV2Cloud] ⚠️ Cannot send receipt for unpaid order: ${requestId} (status: ${order.status})`);
            const err = new Error(`Payment is not completed for request ${requestId}`);
            err.code = 'ORDER_NOT_PAID';
            throw err;
        }

        // 3. Dispatch receipt email
        return await sendPaymentReceipt({
            db: this.db,
            order,
            email,
            transporter: transporterOverride
        });
    }
}

export default PaymentV2CloudService;
