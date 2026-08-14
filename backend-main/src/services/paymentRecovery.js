/**
 * Payment Recovery Service
 * 
 * Handles recovery of payments after Pi restart or network interruption.
 * 
 * SCENARIO:
 * 1. Customer makes payment on their phone (Razorpay)
 * 2. Pi crashes/restarts before receiving verification webhook
 * 3. Transaction is stuck in PENDING with a provider_order_id
 * 4. This service queries Razorpay to check if payment actually succeeded
 * 5. If succeeded, marks transaction as VERIFIED automatically
 * 
 * This ensures:
 * - Customer doesn't have to pay again
 * - Customer gets their report/medicine even if Pi restarted
 * - No manual intervention needed
 */

import crypto from 'crypto';

class PaymentRecoveryService {
    constructor(transactionManager, sessionManager, razorpayInstance, razorpayKeySecret) {
        this.transactionManager = transactionManager;
        this.sessionManager = sessionManager;
        this.razorpay = razorpayInstance;
        this.razorpayKeySecret = razorpayKeySecret;
        this.isRunning = false;
        this.recoveryInterval = null;
    }

    /**
     * Start the recovery service
     * Runs immediately on startup, then periodically
     */
    start(intervalMinutes = 5) {
        if (this.isRunning) {
            console.log('[PaymentRecovery] Already running');
            return;
        }

        if (!this.razorpay || !this.razorpayKeySecret) {
            console.log('[PaymentRecovery] ⚠️  Razorpay not configured - payment recovery disabled');
            return;
        }

        console.log('[PaymentRecovery] 🚀 Starting payment recovery service');
        this.isRunning = true;

        // Run immediately on startup
        this.recoverPendingPayments().catch(err => {
            console.error('[PaymentRecovery] ❌ Startup recovery failed:', err.message);
        });

        // Run periodically
        const intervalMs = intervalMinutes * 60 * 1000;
        this.recoveryInterval = setInterval(() => {
            this.recoverPendingPayments().catch(err => {
                console.error('[PaymentRecovery] ❌ Periodic recovery failed:', err.message);
            });
        }, intervalMs);

        console.log(`[PaymentRecovery] Will check every ${intervalMinutes} minutes`);
    }

    /**
     * Stop the recovery service
     */
    stop() {
        if (this.recoveryInterval) {
            clearInterval(this.recoveryInterval);
            this.recoveryInterval = null;
        }
        this.isRunning = false;
        console.log('[PaymentRecovery] Stopped');
    }

    /**
     * Recover pending payments by querying Razorpay
     */
    async recoverPendingPayments() {
        try {
            // Get all PENDING transactions with Razorpay orders
            const pendingTransactions = this.transactionManager.getPendingTransactionsWithOrders();

            if (pendingTransactions.length === 0) {
                console.log('[PaymentRecovery] ✅ No pending transactions to recover');
                return { recovered: 0, failed: 0, total: 0 };
            }

            console.log(`[PaymentRecovery] 🔍 Found ${pendingTransactions.length} pending transaction(s) with orders`);

            let recovered = 0;
            let failed = 0;

            for (const transaction of pendingTransactions) {
                try {
                    const result = await this.attemptRecovery(transaction);
                    if (result.recovered) {
                        recovered++;
                        console.log(`[PaymentRecovery] ✅ Recovered payment for transaction ${transaction.transaction_id}`);
                    } else {
                        console.log(`[PaymentRecovery] ⏳ Transaction ${transaction.transaction_id} - ${result.reason}`);
                    }
                } catch (err) {
                    failed++;
                    console.error(`[PaymentRecovery] ❌ Failed to recover ${transaction.transaction_id}:`, err.message);
                }
            }

            console.log(`[PaymentRecovery] 📊 Recovery summary: ${recovered} recovered, ${failed} failed, ${pendingTransactions.length} total`);

            return { recovered, failed, total: pendingTransactions.length };

        } catch (err) {
            console.error('[PaymentRecovery] ❌ Recovery process error:', err.message);
            throw err;
        }
    }

    /**
     * Attempt to recover a single transaction
     */
    async attemptRecovery(transaction) {
        const orderId = transaction.provider_order_id;

        // Fetch order details from Razorpay
        const order = await this.razorpay.orders.fetch(orderId);

        // Check if order has any payments
        const payments = await this.razorpay.orders.fetchPayments(orderId);

        if (!payments || !payments.items || payments.items.length === 0) {
            return { recovered: false, reason: 'No payments found for order' };
        }

        // Find a captured payment
        const capturedPayment = payments.items.find(p => p.status === 'captured');

        if (!capturedPayment) {
            return { recovered: false, reason: 'No captured payment found' };
        }

        // Validate amount matches
        if (capturedPayment.amount !== transaction.amount) {
            console.warn(
                `[PaymentRecovery] ⚠️  Amount mismatch for ${transaction.transaction_id}: ` +
                `expected ${transaction.amount}, got ${capturedPayment.amount}`
            );
            return { recovered: false, reason: 'Amount mismatch' };
        }

        // ✅ Payment is valid! Mark as verified
        console.log(`[PaymentRecovery] 💰 Found valid payment ${capturedPayment.id} for ${transaction.transaction_id}`);

        // Verify the payment (idempotent - safe to call even if already verified)
        this.transactionManager.verifyPayment(
            transaction.transaction_id,
            capturedPayment.id,
            capturedPayment
        );

        // Update session status
        this.sessionManager.markPaymentVerified(
            transaction.session_id,
            capturedPayment.id
        );

        return { 
            recovered: true, 
            paymentId: capturedPayment.id,
            amount: capturedPayment.amount / 100
        };
    }

    /**
     * Manually trigger recovery for a specific session
     */
    async recoverSession(sessionId) {
        const transaction = this.transactionManager.getTransactionBySession(sessionId);

        if (!transaction) {
            throw new Error(`No transaction found for session ${sessionId}`);
        }

        if (transaction.status !== 'PENDING') {
            return { 
                recovered: false, 
                reason: `Transaction already in state: ${transaction.status}` 
            };
        }

        if (!transaction.provider_order_id) {
            return { 
                recovered: false, 
                reason: 'No Razorpay order ID found' 
            };
        }

        return await this.attemptRecovery(transaction);
    }
}

export default PaymentRecoveryService;
