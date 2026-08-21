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

        // 1. Check idempotency: if already verified or fulfilled
        const isAlreadyVerified = transaction.status === 'VERIFIED' || 
                                  transaction.status === 'FULFILLED' || 
                                  transaction.verified === 1;

        let createdJobs = [];

        if (isAlreadyVerified) {
            console.log(`[PaymentFinalization] Transaction ${transactionId} is already verified (idempotent skip)`);
            const existingJobs = this.fulfillmentManager.getJobsByTransaction ? 
                this.fulfillmentManager.getJobsByTransaction(transactionId) : [];

            return {
                success: true,
                alreadyVerified: true,
                completionStatus: session.service_type === 'MEDICINE' ? 'dispensing' : 'report_ready',
                jobs: existingJobs
            };
        }

        // 2. Perform atomic DB state transition
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

            if (session.service_type === 'HEALTH_CHECKUP') {
                this.sessionManager.updateReportStatus(sessionId, 'GENERATING');
            }
        });

        console.log(`[PaymentFinalization] ✅ Payment verified and state transitioned for session ${sessionId}, transaction ${transactionId}`);

        // 3. Post-processing: Dispensing or PDF generation
        let completionStatus = 'report_ready';

        if (session.service_type === 'MEDICINE') {
            const cart = transaction.cart ? 
                (typeof transaction.cart === 'string' ? JSON.parse(transaction.cart) : transaction.cart) 
                : [];

            if (cart.length > 0) {
                for (const item of cart) {
                    const job = await this.fulfillmentManager.createJob(
                        sessionId,
                        transactionId,
                        item.kit_id,
                        item.quantity
                    );
                    createdJobs.push(job);
                }
                this.sessionManager.markFulfillment(sessionId);
            }

            for (const job of createdJobs) {
                const jobId = job.job_id || job.jobId;
                try {
                    await this.fulfillmentManager.startDispensing(jobId);
                    console.log(`[PaymentFinalization] ✅ Dispensing started for job: ${jobId}`);
                } catch (err) {
                    console.error(`[PaymentFinalization] ⚠️ Dispense publish failed for job ${jobId}:`, err.message);
                }
            }
            completionStatus = 'dispensing';

        } else if (session.service_type === 'HEALTH_CHECKUP') {
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
        }

        return {
            success: true,
            alreadyVerified: false,
            completionStatus,
            jobs: createdJobs
        };
    }
}

export const paymentFinalizationService = new PaymentFinalizationService();
export default paymentFinalizationService;
