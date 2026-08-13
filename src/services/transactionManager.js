/**
 * TransactionManager - Authoritative Payment & Transaction Management
 * 
 * CRITICAL SECURITY RULES:
 * 1. NEVER trust frontend amounts - backend calculates from inventory prices
 * 2. All payment verifications are idempotent (safe to retry)
 * 3. Amount validation: Razorpay payment must match transaction amount
 * 4. Transaction states are immutable once verified
 * 5. All operations link to session_id (GOLDEN RULE)
 */

import { getDb } from '../database/db.js';

// Transaction states (must match schema CHECK constraint)
const TRANSACTION_STATES = {
    PENDING: 'PENDING',           // Transaction created, payment pending
    VERIFIED: 'VERIFIED',         // Payment verified
    FULFILLED: 'FULFILLED',       // Dispensed/report sent
    FAILED: 'FAILED',             // Payment failed/expired
};

// Valid state transitions
const VALID_TRANSITIONS = {
    PENDING: ['VERIFIED', 'FAILED'],
    VERIFIED: ['FULFILLED', 'FAILED'],
    FULFILLED: [],
    FAILED: [],
};

// Service pricing (in INR, paise)
const SERVICE_PRICING = {
    HEALTH_CHECKUP: 10000,  // ₹100.00 (10000 paise)
    MEDICINE: 0,            // Calculated from cart
};

class TransactionManager {
    constructor() {
        this.db = null;
    }

    initialize() {
        this.db = getDb();
        console.log('[TransactionManager] Initialized');
    }

    /**
     * Create a new transaction with backend-calculated amount
     * GOLDEN RULE: Links to session_id
     * 
     * @param {string} sessionId - Session ID
     * @param {string} serviceType - 'HEALTH_CHECKUP' | 'MEDICINE'
     * @param {Array} cart - Medicine cart items [{medicine_id, quantity}]
     * @returns {Object} Transaction with authoritative amount
     */
    createTransaction(sessionId, serviceType, cart = []) {
        if (!sessionId) {
            throw new Error('sessionId is required');
        }

        if (!['HEALTH_CHECKUP', 'MEDICINE'].includes(serviceType)) {
            throw new Error('serviceType must be HEALTH_CHECKUP or MEDICINE');
        }

        // ✅ BACKEND calculates amount (NEVER trust frontend)
        const amount = this._calculateAmount(serviceType, cart);

        // Generate unique transaction ID
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 10).toUpperCase();
        const transactionId = `TXN-${timestamp}-${random}`;

        const stmt = this.db.prepare(`
            INSERT INTO transactions (
                transaction_id, session_id, type, amount, 
                cart, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);

        stmt.run(
            transactionId,
            sessionId,
            serviceType,
            amount,
            JSON.stringify(cart),
            TRANSACTION_STATES.PENDING  // Changed from CREATED to PENDING
        );

        console.log(`[TransactionManager] Created transaction ${transactionId} for ₹${amount / 100} (session: ${sessionId})`);

        return this.getTransaction(transactionId);
    }

    /**
     * Calculate transaction amount from service type and cart
     * This is the AUTHORITATIVE source of pricing
     * 
     * @private
     */
    _calculateAmount(serviceType, cart) {
        if (serviceType === 'HEALTH_CHECKUP') {
            return SERVICE_PRICING.HEALTH_CHECKUP;
        }

        if (serviceType === 'MEDICINE') {
            if (!cart || cart.length === 0) {
                throw new Error('Medicine service requires cart items');
            }

            let total = 0;

            // Get prices from inventory table (authoritative source)
            for (const item of cart) {
                const inventoryItem = this.db.prepare(`
                    SELECT kit_id, price, quantity
                    FROM inventory
                    WHERE kit_id = ?
                `).get(item.kit_id);

                if (!inventoryItem) {
                    throw new Error(`Medicine ${item.kit_id} not found in inventory`);
                }

                if (inventoryItem.quantity < item.quantity) {
                    throw new Error(`Insufficient stock for ${item.kit_id}: have ${inventoryItem.quantity}, need ${item.quantity}`);
                }

                // Price is stored as REAL (rupees), convert to paise for consistency
                const priceInPaise = Math.round(inventoryItem.price * 100);
                total += priceInPaise * item.quantity;
            }

            return total;
        }

        throw new Error(`Unknown service type: ${serviceType}`);
    }

    /**
     * Mark Razorpay order created (but payment still pending)
     * Updates transaction with provider_order_id
     */
    markOrderCreated(transactionId, providerOrderId) {
        const transaction = this.getTransaction(transactionId);
        
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        // Order creation doesn't change state - still PENDING
        const stmt = this.db.prepare(`
            UPDATE transactions 
            SET provider_order_id = ?,
                updated_at = datetime('now')
            WHERE transaction_id = ?
        `);

        stmt.run(providerOrderId, transactionId);

        console.log(`[TransactionManager] Razorpay order created: ${providerOrderId} for ${transactionId}`);
    }

    /**
     * Mark payment as pending (customer is paying)
     * This is a no-op since transactions start in PENDING state
     */
    markPaymentPending(transactionId) {
        const transaction = this.getTransaction(transactionId);
        
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        // Already in PENDING state
        console.log(`[TransactionManager] Payment pending for ${transactionId} (already PENDING)`);
    }

    /**
     * Verify payment (IDEMPOTENT)
     * 
     * Critical security checks:
     * 1. Check if already verified (idempotency)
     * 2. Validate Razorpay signature (done by caller)
     * 3. Validate payment amount matches transaction amount
     * 4. Validate payment status is 'captured'
     * 5. Store payment proof
     * 
     * @param {string} transactionId
     * @param {string} providerPaymentId - Razorpay payment ID
     * @param {Object} paymentDetails - Full payment object from Razorpay API
     * @returns {Object} { verified: boolean, already_verified: boolean }
     */
    verifyPayment(transactionId, providerPaymentId, paymentDetails) {
        const transaction = this.getTransaction(transactionId);
        
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        // ✅ IDEMPOTENCY: If already verified, return success
        if (transaction.status === TRANSACTION_STATES.VERIFIED || transaction.verified === 1) {
            console.log(`[TransactionManager] Payment already verified for ${transactionId}`);
            return { verified: true, already_verified: true };
        }

        // Validate amount matches (CRITICAL SECURITY CHECK)
        // Razorpay stores in paise, our transaction.amount is also in paise
        if (paymentDetails.amount !== transaction.amount) {
            throw new Error(
                `Amount mismatch: expected ₹${transaction.amount / 100}, got ₹${paymentDetails.amount / 100}`
            );
        }

        // Validate payment is captured
        if (paymentDetails.status !== 'captured') {
            throw new Error(`Payment not captured: status is ${paymentDetails.status}`);
        }

        // Validate state transition
        this._validateTransition(transaction.status, 'VERIFIED');

        // ✅ Mark as verified and store payment proof
        const stmt = this.db.prepare(`
            UPDATE transactions 
            SET status = ?,
                provider_payment_id = ?,
                verified = 1,
                verified_at = datetime('now'),
                updated_at = datetime('now')
            WHERE transaction_id = ?
        `);

        stmt.run(
            TRANSACTION_STATES.VERIFIED,
            providerPaymentId,
            transactionId
        );

        console.log(`[TransactionManager] ✅ Payment verified: ${providerPaymentId} for ${transactionId}`);

        return { verified: true, already_verified: false };
    }

    /**
     * Mark transaction as fulfilled (medicine dispensed or report sent)
     */
    markFulfilled(transactionId) {
        const transaction = this.getTransaction(transactionId);
        
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        this._validateTransition(transaction.status, 'FULFILLED');

        const stmt = this.db.prepare(`
            UPDATE transactions 
            SET status = ?,
                fulfilled = 1,
                fulfilled_at = datetime('now'),
                updated_at = datetime('now')
            WHERE transaction_id = ?
        `);

        stmt.run(TRANSACTION_STATES.FULFILLED, transactionId);

        console.log(`[TransactionManager] Transaction fulfilled: ${transactionId}`);
    }

    /**
     * Mark transaction as failed
     */
    markFailed(transactionId, reason) {
        const transaction = this.getTransaction(transactionId);
        
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        const stmt = this.db.prepare(`
            UPDATE transactions 
            SET status = ?,
                updated_at = datetime('now')
            WHERE transaction_id = ?
        `);

        stmt.run(TRANSACTION_STATES.FAILED, transactionId);

        console.log(`[TransactionManager] Transaction failed: ${transactionId} - ${reason}`);
    }

    /**
     * Get transaction by ID
     */
    getTransaction(transactionId) {
        const stmt = this.db.prepare(`
            SELECT * FROM transactions WHERE transaction_id = ?
        `);
        const transaction = stmt.get(transactionId);

        if (!transaction) {
            return null;
        }

        // Parse JSON fields
        return {
            ...transaction,
            cart: transaction.cart ? JSON.parse(transaction.cart) : [],
        };
    }

    /**
     * Get transaction by session ID
     * Returns the most recent transaction for the session
     */
    getTransactionBySession(sessionId) {
        const stmt = this.db.prepare(`
            SELECT * FROM transactions 
            WHERE session_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        const transaction = stmt.get(sessionId);

        if (!transaction) {
            return null;
        }

        return {
            ...transaction,
            cart: transaction.cart ? JSON.parse(transaction.cart) : [],
        };
    }

    /**
     * Get transaction by Razorpay order ID
     */
    getTransactionByOrderId(providerOrderId) {
        const stmt = this.db.prepare(`
            SELECT * FROM transactions 
            WHERE provider_order_id = ?
        `);
        const transaction = stmt.get(providerOrderId);

        if (!transaction) {
            return null;
        }

        return {
            ...transaction,
            cart: transaction.cart ? JSON.parse(transaction.cart) : [],
        };
    }

    /**
     * Get all pending transactions that have Razorpay orders created
     * (Used for payment recovery after Pi restart)
     */
    getPendingTransactionsWithOrders() {
        const stmt = this.db.prepare(`
            SELECT * FROM transactions 
            WHERE status = ? 
            AND provider_order_id IS NOT NULL
            AND provider_order_id != ''
            ORDER BY created_at DESC
        `);
        const transactions = stmt.all(TRANSACTION_STATES.PENDING);

        return transactions.map(tx => ({
            ...tx,
            cart: tx.cart ? JSON.parse(tx.cart) : [],
        }));
    }

    /**
     * Check if transaction is verified
     */
    isVerified(transactionId) {
        const transaction = this.getTransaction(transactionId);
        return transaction && (transaction.status === TRANSACTION_STATES.VERIFIED || transaction.verified === 1);
    }

    /**
     * Check if transaction is fulfilled
     */
    isFulfilled(transactionId) {
        const transaction = this.getTransaction(transactionId);
        return transaction && (transaction.status === TRANSACTION_STATES.FULFILLED || transaction.fulfilled === 1);
    }

    /**
     * Validate state transition
     * @private
     */
    _validateTransition(currentState, newState) {
        const allowedTransitions = VALID_TRANSITIONS[currentState];
        
        if (!allowedTransitions || !allowedTransitions.includes(newState)) {
            throw new Error(
                `Invalid transaction state transition: ${currentState} → ${newState}`
            );
        }
    }
}

// Singleton instance
const transactionManager = new TransactionManager();

export { transactionManager, TRANSACTION_STATES };
