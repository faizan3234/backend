/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - PAYMENT V2 SERVICE (Zero-Internet Kiosk)
 * Purpose: Authoritative offline payment request creation, Ed25519 signing,
 *          RSA-OAEP hybrid encryption, and timing-safe confirmation code verification.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import fs from 'fs';
import path from 'path';
import { getDb, transaction as dbTransaction } from '../database/db.js';
import sessionManagerInstance from './sessionManager.js';
import { transactionManager as transactionManagerInstance } from './transactionManager.js';
import paymentFinalizationServiceInstance from './paymentFinalizationService.js';
import {
    generateConfirmationCode,
    generateRequestId,
    generateRequestNonce,
    signPayload,
    encryptPackage,
    calculateCodeHmac,
    verifyCodeHmac
} from './paymentV2Crypto.js';

/**
 * Deterministically normalize and sort cart items by kit_id
 * @param {Array} cart 
 * @returns {Array<{kit_id: string, quantity: number}>}
 */
export function getCanonicalCart(cart) {
    if (!Array.isArray(cart)) return [];
    return cart
        .map(item => {
            const rawQty = item.cartQuantity ?? item.quantityRequested ?? item.selectedQuantity ?? item.quantity;
            const parsedQty = parseInt(rawQty, 10);
            return {
                kit_id: String(item.kit_id || item._id || item.id || '').trim(),
                quantity: Number.isInteger(parsedQty) && parsedQty > 0 ? parsedQty : 1
            };
        })
        .filter(item => Boolean(item.kit_id))
        .sort((a, b) => a.kit_id.localeCompare(b.kit_id));
}

/**
 * Compare two carts for canonical equality
 * @param {Array} cartA 
 * @param {Array} cartB 
 * @returns {boolean}
 */
export function areCartsEqual(cartA, cartB) {
    const canonicalA = getCanonicalCart(cartA);
    const canonicalB = getCanonicalCart(cartB);
    if (canonicalA.length !== canonicalB.length) return false;
    for (let i = 0; i < canonicalA.length; i++) {
        if (canonicalA[i].kit_id !== canonicalB[i].kit_id || canonicalA[i].quantity !== canonicalB[i].quantity) {
            return false;
        }
    }
    return true;
}

export class PaymentV2Service {
    constructor({
        db = null,
        sessionManager = sessionManagerInstance,
        transactionManager = transactionManagerInstance,
        paymentFinalizationService = paymentFinalizationServiceInstance,
        pepper = process.env.PAYMENT_V2_CODE_PEPPER || '',
        kioskSigningPrivateKeyPath = process.env.PAYMENT_V2_KIOSK_SIGNING_PRIVATE_KEY_PATH || './config/payment-v2-kiosk-private-key.pem',
        cloudEncryptionPublicKeyPath = process.env.PAYMENT_V2_CLOUD_ENCRYPTION_PUBLIC_KEY_PATH || './config/payment-v2-cloud-encryption-public-key.pem',
        kioskId = process.env.PAYMENT_V2_KIOSK_ID || 'RELIV-001',
        ttlSeconds = Number(process.env.PAYMENT_V2_TTL_SECONDS) || 300,
        maxAttempts = Number(process.env.PAYMENT_V2_MAX_ATTEMPTS) || 5,
        paymentUrlBase = 'https://reliv7.vercel.app/pay'
    } = {}) {
        this._db = db;
        this.sessionManager = sessionManager;
        this.transactionManager = transactionManager;
        this.paymentFinalizationService = paymentFinalizationService;
        this.pepper = pepper;
        this.kioskSigningPrivateKeyPath = kioskSigningPrivateKeyPath;
        this.cloudEncryptionPublicKeyPath = cloudEncryptionPublicKeyPath;
        this.kioskId = kioskId;
        this.ttlSeconds = ttlSeconds;
        this.maxAttempts = maxAttempts;
        this.paymentUrlBase = paymentUrlBase;

        this._kioskPrivateKey = null;
        this._cloudPublicKey = null;
    }

    get db() {
        if (!this._db) {
            this._db = getDb();
        }
        return this._db;
    }

    /**
     * Check if Payment V2 is fully configured with required pepper and keys
     * @returns {boolean}
     */
    isConfigured() {
        if (!this.pepper || !String(this.pepper).trim()) {
            return false;
        }
        try {
            const privateKey = this._getKioskPrivateKey();
            const publicKey = this._getCloudPublicKey();
            return Boolean(privateKey && publicKey);
        } catch {
            return false;
        }
    }

    _getKioskPrivateKey() {
        if (this._kioskPrivateKey) {
            return this._kioskPrivateKey;
        }
        if (!this.kioskSigningPrivateKeyPath || !fs.existsSync(this.kioskSigningPrivateKeyPath)) {
            throw new Error(`Kiosk signing private key not found at ${this.kioskSigningPrivateKeyPath}`);
        }
        const key = fs.readFileSync(this.kioskSigningPrivateKeyPath, 'utf8');
        this._kioskPrivateKey = key;
        return key;
    }

    _getCloudPublicKey() {
        if (this._cloudPublicKey) {
            return this._cloudPublicKey;
        }
        if (!this.cloudEncryptionPublicKeyPath || !fs.existsSync(this.cloudEncryptionPublicKeyPath)) {
            throw new Error(`Cloud encryption public key not found at ${this.cloudEncryptionPublicKeyPath}`);
        }
        const key = fs.readFileSync(this.cloudEncryptionPublicKeyPath, 'utf8');
        this._cloudPublicKey = key;
        return key;
    }

    /**
     * Expire stale active requests based on persisted expires_at timestamp
     */
    expireStaleRequests() {
        try {
            const now = Date.now();
            const stmt = this.db.prepare(`
                UPDATE payment_v2_requests
                SET status = 'EXPIRED'
                WHERE status = 'ACTIVE' AND expires_at <= ?
            `);
            const result = stmt.run(now);
            if (result.changes > 0) {
                console.log(`[PaymentV2] Expired ${result.changes} stale payment request(s)`);
            }
        } catch (err) {
            console.error('[PaymentV2] Error expiring stale requests:', err.message);
        }
    }

    /**
     * Create an offline Payment V2 request for a session
     * IDEMPOTENT: Returns existing active request for the same unpaid transaction
     *
     * @param {string} sessionId - Kiosk Session ID
     * @param {Object} [options]
     * @param {string} [options.serviceType] - 'MEDICINE' | 'HEALTH_CHECKUP'
     * @param {Array} [options.cart] - [{ kit_id, quantity }]
     * @returns {Promise<Object>}
     */
    async createPaymentRequest(sessionId, { serviceType = null, cart = [] } = {}) {
        if (!this.isConfigured()) {
            const err = new Error('Payment V2 is not configured on this kiosk. Required keys or pepper missing.');
            err.code = 'PAYMENT_V2_NOT_CONFIGURED';
            throw err;
        }

        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        if (session.status === 'COMPLETED') {
            throw new Error(`Session ${sessionId} is already completed`);
        }

        // Clean up expired requests first
        this.expireStaleRequests();

        const effectiveServiceType = serviceType || session.service_type || 'HEALTH_CHECKUP';
        const canonicalNewCart = getCanonicalCart(cart);
        const now = Date.now();

        // 1. Resolve or create authoritative transaction with cart-aware idempotency
        let transaction = this.transactionManager.getTransactionBySession(sessionId);

        if (transaction) {
            if (transaction.status === 'VERIFIED' || transaction.status === 'FULFILLED' || transaction.verified === 1) {
                throw new Error(`Transaction ${transaction.transaction_id} is already paid`);
            }

            const transactionCart = Array.isArray(transaction.cart) ? transaction.cart : (typeof transaction.cart === 'string' ? JSON.parse(transaction.cart || '[]') : []);
            const isSameCart = areCartsEqual(transactionCart, canonicalNewCart);
            const isSameServiceType = (transaction.type === effectiveServiceType);

            if (isSameCart && isSameServiceType && transaction.status === 'PENDING') {
                // CASE 1: Exact same cart + same serviceType on unpaid PENDING transaction
                // Check if active Payment V2 request exists and is valid
                const existingStmt = this.db.prepare(`
                    SELECT * FROM payment_v2_requests
                    WHERE session_id = ? AND transaction_id = ? AND status = 'ACTIVE' AND expires_at > ? AND attempt_count < max_attempts
                    ORDER BY created_at DESC LIMIT 1
                `);
                const existingRequest = existingStmt.get(sessionId, transaction.transaction_id, now);

                if (existingRequest) {
                    console.log(`[PaymentV2] Returning existing active payment request: ${existingRequest.request_id} (idempotent same cart)`);
                    return {
                        ok: true,
                        requestId: existingRequest.request_id,
                        sessionId: existingRequest.session_id,
                        transactionId: existingRequest.transaction_id,
                        amount: existingRequest.amount,
                        currency: 'INR',
                        expiresAt: existingRequest.expires_at,
                        paymentUrl: `${this.paymentUrlBase}#p=${existingRequest.encrypted_package}`
                    };
                }
            } else {
                // CASE 2: Cart changed or serviceType changed on unpaid transaction!
                console.log(`[PaymentV2] Cart or serviceType changed for session ${sessionId}. Cancelling prior request & transaction.`);
                // Cancel prior active payment requests for this session
                this.db.prepare(`
                    UPDATE payment_v2_requests
                    SET status = 'CANCELLED', cancelled_at = ?
                    WHERE session_id = ? AND status = 'ACTIVE'
                `).run(now, sessionId);

                // Mark prior pending transaction as FAILED (superseded)
                if (transaction.status === 'PENDING') {
                    this.db.prepare(`
                        UPDATE transactions
                        SET status = 'FAILED', updated_at = datetime('now')
                        WHERE transaction_id = ? AND status = 'PENDING'
                    `).run(transaction.transaction_id);
                }

                // Create brand new authoritative transaction with new cart
                transaction = this.transactionManager.createTransaction(sessionId, effectiveServiceType, canonicalNewCart);
            }
        } else {
            transaction = this.transactionManager.createTransaction(sessionId, effectiveServiceType, canonicalNewCart);
        }

        const authoritativeAmount = transaction.amount;

        // Atomically cancel any lingering prior active requests for this session
        this.db.prepare(`
            UPDATE payment_v2_requests
            SET status = 'CANCELLED', cancelled_at = ?
            WHERE session_id = ? AND status = 'ACTIVE'
        `).run(now, sessionId);

        // 4. Generate new V2 payment request data
        const requestId = generateRequestId();
        const requestNonce = generateRequestNonce();
        const confirmationCode = generateConfirmationCode();
        const expiresAt = now + (this.ttlSeconds * 1000);

        // Calculate HMAC code verifier (never store plaintext code in DB)
        const codeHmac = calculateCodeHmac(this.pepper, {
            version: 2,
            requestId,
            requestNonce,
            sessionId,
            transactionId: transaction.transaction_id,
            amount: authoritativeAmount,
            confirmationCode
        });

        // Build canonical payload
        const canonicalPayload = {
            v: 2,
            type: 'RELIV_PAYMENT_REQUEST',
            kioskId: this.kioskId,
            requestId,
            requestNonce,
            sessionId,
            transactionId: transaction.transaction_id,
            amount: authoritativeAmount,
            currency: 'INR',
            serviceType: session.service_type || transaction.type,
            confirmationCode,
            issuedAt: now,
            expiresAt
        };

        // Sign with Kiosk Ed25519 Private Key
        const kioskPrivateKey = this._getKioskPrivateKey();
        const signature = signPayload(canonicalPayload, kioskPrivateKey);

        // Hybrid Encrypt for Cloud with RSA-OAEP + AES-256-GCM
        const cloudPublicKey = this._getCloudPublicKey();
        const encryptedPackage = encryptPackage({
            payload: canonicalPayload,
            signature
        }, cloudPublicKey);

        // Persist request in SQLite
        const insertStmt = this.db.prepare(`
            INSERT INTO payment_v2_requests (
                request_id, request_nonce, session_id, transaction_id, kiosk_id,
                amount, service_type, code_hmac, encrypted_package, status,
                attempt_count, max_attempts, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?)
        `);

        insertStmt.run(
            requestId,
            requestNonce,
            sessionId,
            transaction.transaction_id,
            this.kioskId,
            authoritativeAmount,
            session.service_type || transaction.type,
            codeHmac,
            encryptedPackage,
            this.maxAttempts,
            now,
            expiresAt
        );

        // Security logging: ONLY safe identifiers/amounts, NEVER code/HMAC/keys
        console.log(`[PaymentV2] Payment request created: ${requestId} (session: ${sessionId}, transaction: ${transaction.transaction_id}, amount: ₹${authoritativeAmount / 100}, expires in ${this.ttlSeconds}s)`);

        return {
            ok: true,
            requestId,
            sessionId,
            transactionId: transaction.transaction_id,
            amount: authoritativeAmount,
            currency: 'INR',
            expiresAt,
            paymentUrl: `${this.paymentUrlBase}#p=${encryptedPackage}`
        };
    }

    /**
     * Get status of Payment V2 for a session
     * @param {string} sessionId
     * @returns {Object}
     */
    getPaymentStatus(sessionId) {
        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        this.expireStaleRequests();

        const request = this.db.prepare(`
            SELECT * FROM payment_v2_requests
            WHERE session_id = ?
            ORDER BY created_at DESC LIMIT 1
        `).get(sessionId);

        if (!request) {
            return {
                ok: true,
                status: 'NONE',
                paymentVerified: false
            };
        }

        const transaction = this.transactionManager.getTransaction(request.transaction_id);
        const isVerified = request.status === 'VERIFIED' || 
                           (transaction && (transaction.status === 'VERIFIED' || transaction.status === 'FULFILLED' || transaction.verified === 1));

        return {
            ok: true,
            requestId: request.request_id,
            transactionId: request.transaction_id,
            amount: request.amount,
            status: request.status,
            expiresAt: request.expires_at,
            attemptsRemaining: Math.max(0, request.max_attempts - request.attempt_count),
            paymentVerified: Boolean(isVerified),
            paymentUrl: request.status === 'ACTIVE' ? `${this.paymentUrlBase}#p=${request.encrypted_package}` : null
        };
    }

    /**
     * Explicitly cancel active Payment V2 request and associated unpaid transaction for a session
     * @param {string} sessionId
     * @returns {Object} { ok: true, cancelled: boolean, requestId, transactionId }
     */
    cancelPaymentRequest(sessionId) {
        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        const now = Date.now();

        // 1. Find any ACTIVE payment request
        const activeRequest = this.db.prepare(`
            SELECT * FROM payment_v2_requests
            WHERE session_id = ? AND status = 'ACTIVE'
            ORDER BY created_at DESC LIMIT 1
        `).get(sessionId);

        let cancelled = false;
        let requestId = null;
        let transactionId = null;

        if (activeRequest) {
            requestId = activeRequest.request_id;
            transactionId = activeRequest.transaction_id;

            this.db.prepare(`
                UPDATE payment_v2_requests
                SET status = 'CANCELLED', cancelled_at = ?
                WHERE request_id = ?
            `).run(now, requestId);

            cancelled = true;
            console.log(`[PaymentV2] Explicitly cancelled payment request ${requestId} for session ${sessionId}`);

            // Also mark associated transaction FAILED if still PENDING (never cancel VERIFIED / FULFILLED)
            if (transactionId) {
                const txn = this.transactionManager.getTransaction(transactionId);
                if (txn && txn.status === 'PENDING') {
                    this.db.prepare(`
                        UPDATE transactions
                        SET status = 'FAILED', updated_at = datetime('now')
                        WHERE transaction_id = ? AND status = 'PENDING'
                    `).run(transactionId);
                    console.log(`[PaymentV2] Marked unpaid transaction ${transactionId} as FAILED (cancelled)`);
                }
            }
        } else {
            // Also check if any PENDING transaction exists without active request for this session
            const pendingTxn = this.transactionManager.getTransactionBySession(sessionId);
            if (pendingTxn && pendingTxn.status === 'PENDING') {
                transactionId = pendingTxn.transaction_id;
                this.db.prepare(`
                    UPDATE transactions
                    SET status = 'FAILED', updated_at = datetime('now')
                    WHERE transaction_id = ? AND status = 'PENDING'
                `).run(transactionId);
                cancelled = true;
                console.log(`[PaymentV2] Marked lingering unpaid transaction ${transactionId} as FAILED for session ${sessionId}`);
            }
        }

        return {
            ok: true,
            cancelled: true,
            requestId,
            transactionId
        };
    }

    /**
     * Verify customer-entered 4-digit confirmation code offline
     *
     * @param {string} sessionId
     * @param {Object} params
     * @param {string} [params.requestId]
     * @param {string} params.code - 4-digit numeric code
     * @returns {Promise<Object>} Verification result
     */
    async verifyConfirmationCode(sessionId, { requestId = null, code } = {}) {
        if (!this.isConfigured()) {
            const err = new Error('Payment V2 is not configured');
            err.code = 'PAYMENT_V2_NOT_CONFIGURED';
            throw err;
        }

        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        // Validate 4-digit format strictly
        const normalizedCode = String(code || '').trim();
        if (!/^\d{4}$/.test(normalizedCode)) {
            return {
                ok: false,
                code: 'INVALID_FORMAT',
                message: 'Confirmation code must be exactly 4 numeric digits'
            };
        }

        this.expireStaleRequests();

        // 1. Fetch request
        let request;
        if (requestId) {
            request = this.db.prepare('SELECT * FROM payment_v2_requests WHERE request_id = ?').get(requestId);
        } else {
            request = this.db.prepare('SELECT * FROM payment_v2_requests WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
        }

        if (!request) {
            return {
                ok: false,
                code: 'REQUEST_NOT_FOUND',
                message: 'No payment request found for this session'
            };
        }

        // 2. Validate request bindings
        if (request.session_id !== sessionId) {
            console.warn(`[PaymentV2] ❌ Security mismatch: Request ${request.request_id} session ${request.session_id} != ${sessionId}`);
            return {
                ok: false,
                code: 'SESSION_MISMATCH',
                message: 'Payment request does not belong to this session'
            };
        }

        const transaction = this.transactionManager.getTransaction(request.transaction_id);
        if (!transaction) {
            return {
                ok: false,
                code: 'TRANSACTION_NOT_FOUND',
                message: 'Transaction not found'
            };
        }

        if (request.amount !== transaction.amount) {
            console.error(`[PaymentV2] ❌ Security violation: Amount tampering detected between request (${request.amount}) and transaction (${transaction.amount})`);
            return {
                ok: false,
                code: 'AMOUNT_MISMATCH',
                message: 'Payment amount mismatch'
            };
        }

        // 3. Check if already verified / fulfilled (Idempotency)
        if (request.status === 'VERIFIED' || transaction.status === 'VERIFIED' || transaction.status === 'FULFILLED' || transaction.verified === 1) {
            console.log(`[PaymentV2] Request ${request.request_id} is already verified (idempotent confirmation)`);
            const finalResult = await this.paymentFinalizationService.finalizeVerifiedPayment({
                sessionId: request.session_id,
                transactionId: request.transaction_id,
                verificationSource: 'CLOUD_CODE_V2',
                verificationReference: request.request_id,
                amount: request.amount
            });

            return {
                ok: true,
                status: 'VERIFIED',
                alreadyVerified: true,
                ...finalResult
            };
        }

        // 4. Status checks: LOCKED, CANCELLED, EXPIRED
        if (request.status === 'LOCKED') {
            return {
                ok: false,
                code: 'LOCKED',
                attemptsRemaining: 0,
                message: 'Maximum confirmation attempts exceeded. Request is locked.'
            };
        }

        if (request.status === 'CANCELLED') {
            return {
                ok: false,
                code: 'PAYMENT_REQUEST_CANCELLED',
                message: 'Payment request has been cancelled or superseded'
            };
        }

        if (request.status === 'EXPIRED' || Date.now() > request.expires_at) {
            this.db.prepare("UPDATE payment_v2_requests SET status = 'EXPIRED' WHERE request_id = ?").run(request.request_id);
            return {
                ok: false,
                code: 'EXPIRED',
                message: 'Payment request has expired. Please create a new request.'
            };
        }

        if (request.attempt_count >= request.max_attempts) {
            this.db.prepare("UPDATE payment_v2_requests SET status = 'LOCKED' WHERE request_id = ?").run(request.request_id);
            return {
                ok: false,
                code: 'LOCKED',
                attemptsRemaining: 0,
                message: 'Maximum confirmation attempts exceeded. Request is locked.'
            };
        }

        // 5. Timing-safe verification of code HMAC
        const isMatch = verifyCodeHmac(request.code_hmac, this.pepper, {
            version: 2,
            requestId: request.request_id,
            requestNonce: request.request_nonce,
            sessionId: request.session_id,
            transactionId: request.transaction_id,
            amount: request.amount,
            confirmationCode: normalizedCode
        });

        // 6. Handle Wrong Code
        if (!isMatch) {
            const newAttempts = request.attempt_count + 1;
            const isNowLocked = newAttempts >= request.max_attempts;
            const newStatus = isNowLocked ? 'LOCKED' : 'ACTIVE';

            this.db.prepare(`
                UPDATE payment_v2_requests
                SET attempt_count = ?, status = ?
                WHERE request_id = ?
            `).run(newAttempts, newStatus, request.request_id);

            console.warn(`[PaymentV2] ❌ Wrong confirmation code for request ${request.request_id} (attempt ${newAttempts}/${request.max_attempts})`);

            if (isNowLocked) {
                return {
                    ok: false,
                    code: 'LOCKED',
                    attemptsRemaining: 0,
                    message: 'Too many incorrect attempts. Payment request is locked.'
                };
            }

            return {
                ok: false,
                code: 'INVALID_CODE',
                attemptsRemaining: request.max_attempts - newAttempts,
                message: 'Invalid confirmation code.'
            };
        }

        // 7. Handle Correct Code (Atomic state update)
        const now = Date.now();
        const updateResult = this.db.prepare(`
            UPDATE payment_v2_requests
            SET status = 'VERIFIED', verified_at = ?, consumed_at = ?
            WHERE request_id = ? AND status = 'ACTIVE'
        `).run(now, now, request.request_id);

        if (updateResult.changes === 0) {
            // Concurrent request already changed the status
            console.log(`[PaymentV2] Request ${request.request_id} was already consumed concurrently`);
            return {
                ok: true,
                status: 'VERIFIED',
                alreadyVerified: true
            };
        }

        console.log(`[PaymentV2] ✅ Confirmation code verified successfully for request ${request.request_id}`);

        // 8. Invoke common payment finalization pipeline (idempotent, triggers fulfillment / report)
        const finalResult = await this.paymentFinalizationService.finalizeVerifiedPayment({
            sessionId: request.session_id,
            transactionId: request.transaction_id,
            verificationSource: 'CLOUD_CODE_V2',
            verificationReference: request.request_id,
            amount: request.amount
        });

        return {
            ok: true,
            status: 'VERIFIED',
            alreadyVerified: false,
            ...finalResult
        };
    }

    /**
     * Cancel an active payment request
     * @param {string} sessionId
     * @param {string} [requestId]
     * @returns {boolean}
     */
    cancelRequest(sessionId, requestId = null) {
        if (!sessionId) return false;
        const now = Date.now();
        if (requestId) {
            const res = this.db.prepare(`
                UPDATE payment_v2_requests
                SET status = 'CANCELLED', cancelled_at = ?
                WHERE request_id = ? AND session_id = ? AND status = 'ACTIVE'
            `).run(now, requestId, sessionId);
            return res.changes > 0;
        } else {
            const res = this.db.prepare(`
                UPDATE payment_v2_requests
                SET status = 'CANCELLED', cancelled_at = ?
                WHERE session_id = ? AND status = 'ACTIVE'
            `).run(now, sessionId);
            return res.changes > 0;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// LAZY SINGLETON — deferred initialization
// ═══════════════════════════════════════════════════════════════════════════
// In ES modules, all `import` statements are hoisted and their modules
// evaluated BEFORE any module-level code in the importing file.
//
// server.js layout:
//   Line  37: import paymentV2Service …   ← module evaluated HERE (early)
//   Line  85: dotenv.config();            ← .env loaded HERE (later)
//
// If we did `new PaymentV2Service()` at module scope (line 565 old code),
// the constructor would capture process.env.PAYMENT_V2_CODE_PEPPER etc.
// as `undefined` because dotenv hasn't loaded yet.
//
// Fix: defer construction until the first property access or method call,
// which always happens AFTER server.js has called dotenv.config().
// ═══════════════════════════════════════════════════════════════════════════

let _instance = null;

function _getInstance() {
    if (!_instance) {
        _instance = new PaymentV2Service();
    }
    return _instance;
}

/**
 * Lazy-initialized proxy that defers PaymentV2Service construction
 * until first property access (guaranteed after dotenv.config()).
 */
export const paymentV2Service = new Proxy({}, {
    get(_target, prop) {
        const instance = _getInstance();
        const value = instance[prop];
        if (typeof value === 'function') {
            return value.bind(instance);
        }
        return value;
    },
    set(_target, prop, value) {
        const instance = _getInstance();
        instance[prop] = value;
        return true;
    }
});

export default paymentV2Service;

