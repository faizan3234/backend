/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - COMMON PAYMENT FINALIZATION SERVICE
 * Purpose: Unified, idempotent post-verification pipeline for both legacy
 *          and Payment V2 flows.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import sessionManagerInstance from './sessionManager.js';
import { transactionManager as transactionManagerInstance } from './transactionManager.js';
import fulfillmentManagerInstance from './fulfillmentManager.js';
import PDFGenerator from './pdfGenerator.js';
import { getDb, transaction as dbTransaction } from '../database/db.js';

export class PaymentFinalizationService {
    constructor({
        db = null,
        sessionManager = sessionManagerInstance,
        transactionManager = transactionManagerInstance,
        fulfillmentManager = fulfillmentManagerInstance,
        pdfGenerator = null
    } = {}) {
        this._db = db;
        this.sessionManager = sessionManager;
        this.transactionManager = transactionManager;
        this.fulfillmentManager = fulfillmentManager;
        this._pdfGenerator = pdfGenerator;
    }

    get db() {
        if (!this._db) {
            this._db = getDb();
        }
        return this._db;
    }

    get pdfGenerator() {
        if (!this._pdfGenerator) {
            this._pdfGenerator = new PDFGenerator(this.db);
        }
        return this._pdfGenerator;
    }

    /**
     * Finalize verified payment and trigger dispensing or report generation.
     * IDEMPOTENT: If already finalized, returns successfully without duplicate jobs or MQTT dispatches.
     *
     * @param {Object} params
     * @param {string} params.sessionId
     * @param {string} params.transactionId
     * @param {string} [params.verificationSource] - e.g. 'CLOUD_CODE_V2' or 'RAZORPAY_SIGNATURE'
     * @param {string} [params.verificationReference] - e.g. requestId or razorpay_payment_id
     * @param {number} [params.amount] - Verified amount in paise
     * @param {Object} [params.legacyPaymentDetails] - Optional details for legacy verifyPayment
     * @returns {Promise<Object>} Finalization result
     */
    async finalizeVerifiedPayment({
        sessionId,
        transactionId,
        verificationSource = 'CLOUD_CODE_V2',
        verificationReference = null,
        amount = null,
        legacyPaymentDetails = null
    }) {
        if (!sessionId || !transactionId) {
            throw new Error('sessionId and transactionId are required for payment finalization');
        }

        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const transaction = this.transactionManager.getTransaction(transactionId);
        if (!transaction) {
            throw new Error(`Transaction ${transactionId} not found`);
        }

        // 1. Check if transaction is already verified
        const isAlreadyVerified = transaction.status === 'VERIFIED' || 
                                  transaction.status === 'FULFILLED' || 
                                  transaction.verified === 1;

        // 2. Perform atomic DB state transition if not already verified
        if (!isAlreadyVerified) {
            dbTransaction(() => {
                // Verify payment on transactionManager
                if (legacyPaymentDetails) {
                    this.transactionManager.verifyPayment(
                        transactionId,
                        verificationReference,
                        legacyPaymentDetails
                    );
                } else {
                    this.transactionManager.verifyPaymentWithProof({
                        transactionId,
                        source: verificationSource,
                        reference: verificationReference,
                        amount: amount ?? transaction.amount
                    });
                }

                // Update session status
                this.sessionManager.markPaymentVerified(sessionId, verificationReference || 'VERIFIED');

                const effectiveService = String(session.service_type || transaction.type || '').toUpperCase();
                if (effectiveService === 'HEALTH_CHECKUP' || effectiveService === 'CHECKUP') {
                    this.sessionManager.updateReportStatus(sessionId, 'GENERATING');
                }
            });

            console.log(`[PaymentFinalization] ✅ Payment verified and state transitioned for session ${sessionId}, transaction ${transactionId}`);
        } else {
            console.log(`[PaymentFinalization] ℹ️ Transaction ${transactionId} is already verified - reconciling post-payment fulfillment/report`);
        }

        // 3. Post-processing & Reconciliation: Dispensing or PDF generation
        const rawServiceType = session.service_type || transaction.type || '';
        const serviceType = String(rawServiceType).trim().toUpperCase();
        const isMedicine = serviceType === 'MEDICINE' || serviceType === 'MEDICINE_PURCHASE';

        let completionStatus = 'report_ready';
        let allJobs = [];

        if (isMedicine) {
            let cart = [];
            if (transaction.cart) {
                try {
                    cart = typeof transaction.cart === 'string' ? JSON.parse(transaction.cart) : transaction.cart;
                } catch (e) {
                    cart = [];
                }
            }
            if (!Array.isArray(cart)) {
                cart = [];
            }

            // Reconcile fulfillment jobs for every kit in cart
            const jobsToDispense = [];

            let fulfillmentError = null;

            if (cart.length > 0) {
                for (const item of cart) {
                    const kitId = item.kit_id || item.id || item.inventory_id;
                    const qty = Number(item.quantity || item.cartQuantity || 1);
                    const motorId = (item.motor_id !== undefined && item.motor_id !== null) ? Number(item.motor_id) : null;
                    if (!kitId) continue;

                    try {
                        // fulfillmentManager.createJob is idempotent on (transaction_id, kit_id)
                        // Uses the frozen motor_id from checkout
                        const job = await this.fulfillmentManager.createJob(
                            sessionId,
                            transactionId,
                            kitId,
                            qty,
                            motorId
                        );

                        allJobs.push(job);

                        // Safety Rule: Only newly created or safely PENDING jobs may be passed to startDispensing().
                        // Existing COMPLETED, IN_PROGRESS, MANUAL_REVIEW_REQUIRED, or FAILED jobs must NOT be restarted unsafely.
                        if (job && job.state === 'PENDING') {
                            jobsToDispense.push(job);
                        }
                    } catch (jobErr) {
                        console.error(`[PaymentFinalization] ❌ Could not create fulfillment job for kit ${kitId}:`, jobErr.message);
                        fulfillmentError = jobErr;
                    }
                }

                // Mark session fulfillment ONLY if at least one job is actually in progress/dispensing
                if (jobsToDispense.length > 0) {
                    const freshSession = this.sessionManager.getSession(sessionId);
                    if (freshSession && (freshSession.status === 'PAYMENT_VERIFIED' || freshSession.status === 'PAYMENT_REQUIRED')) {
                        try {
                            this.sessionManager.markFulfillment(sessionId);
                        } catch (e) {
                            console.warn(`[PaymentFinalization] Could not mark session fulfillment:`, e.message);
                        }
                    }
                }
            } else {
                // If cart was empty or already fulfilled, fetch any existing jobs
                allJobs = this.fulfillmentManager.getJobsByTransaction ? 
                    this.fulfillmentManager.getJobsByTransaction(transactionId) : [];
            }

            // If allJobs is still empty, retrieve from db
            if (allJobs.length === 0 && this.fulfillmentManager.getJobsByTransaction) {
                allJobs = this.fulfillmentManager.getJobsByTransaction(transactionId);
            }

            // Start dispensing only for safe PENDING jobs with configured motors
            for (const job of jobsToDispense) {
                const jobId = job.job_id || job.jobId;
                try {
                    await this.fulfillmentManager.startDispensing(jobId);
                    console.log(`[PaymentFinalization] ✅ Dispensing started for job: ${jobId}`);
                } catch (err) {
                    console.error(`[PaymentFinalization] ⚠️ Dispense publish failed for job ${jobId}:`, err.message);
                    if (!fulfillmentError) fulfillmentError = err;
                }
            }

            if (fulfillmentError && allJobs.length === 0) {
                completionStatus = 'fulfillment_unconfigured';
            } else {
                completionStatus = 'dispensing';
            }

        } else if (serviceType === 'HEALTH_CHECKUP' || serviceType === 'CHECKUP') {
            const freshSession = this.sessionManager.getSession(sessionId);
            // If report is not already generated and completed
            if (!freshSession || freshSession.report_status !== 'READY') {
                console.log(`[PaymentFinalization] 📄 Generating health report PDF locally for session: ${sessionId}`);
                try {
                    const customerData = session.customer_data ? 
                        (typeof session.customer_data === 'string' ? JSON.parse(session.customer_data) : session.customer_data) 
                        : {};
                    const healthData = session.health_data ? 
                        (typeof session.health_data === 'string' ? JSON.parse(session.health_data) : session.health_data) 
                        : {};

                    const { reportId, pdfPath } = await this.pdfGenerator.generateHealthReport(
                        sessionId,
                        customerData,
                        healthData
                    );
                    console.log(`[PaymentFinalization] ✅ Health report PDF saved locally: ${pdfPath} (reportId: ${reportId})`);

                    this.sessionManager.updateReportStatus(sessionId, 'READY');
                    this.sessionManager.markCompleted(sessionId);
                    completionStatus = 'report_ready';
                } catch (pdfErr) {
                    console.error(`[PaymentFinalization] ❌ Health report PDF generation failed for session ${sessionId}:`, pdfErr);
                    this.sessionManager.updateReportStatus(sessionId, 'FAILED');
                    completionStatus = 'report_failed';
                }
            } else {
                completionStatus = 'report_ready';
            }
        }

        return {
            success: true,
            alreadyVerified: isAlreadyVerified,
            completionStatus,
            jobs: allJobs
        };
    }
}

export const paymentFinalizationService = new PaymentFinalizationService();
export default paymentFinalizationService;
