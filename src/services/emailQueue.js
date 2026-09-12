import fs from 'fs';
import { createHash, randomUUID } from 'node:crypto';

const EMAIL_TYPES = ['EMAIL_REPORT', 'EMAIL_RECEIPT', 'EMAIL_ADMIN_RESET'];
const escapeHTML = (value) => String(value).replace(/[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

class EmailQueueService {
    constructor(db, transporter) {
        this.db = db;
        this.transporter = transporter;
        this.isProcessing = false;
        this.processingInterval = null;
    }

    /**
     * Queue an email for sending
     * Returns immediately - does NOT wait for email to send
     */
    queueEmail(sessionId, type, payload) {
        if (!EMAIL_TYPES.includes(type)) throw new Error('Unsupported email type');
        const documentId = payload?.reportId || payload?.receiptId;
        const eventId = documentId && type !== 'EMAIL_ADMIN_RESET'
            ? 'EVT-' + createHash('sha256').update(JSON.stringify([sessionId, type, documentId])).digest('hex')
            : 'EVT-' + randomUUID();

        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO event_queue (
                event_id, session_id, type, payload, 
                status, attempts, created_at
            ) VALUES (?, ?, ?, ?, 'PENDING', 0, datetime('now'))
        `);

        stmt.run(
            eventId,
            sessionId,
            type,
            JSON.stringify(payload)
        );

        console.log(`[EmailQueue] ✅ Email queued: ${eventId} for session ${sessionId}`);
        return eventId;
    }

    /**
     * Start background email processing worker
     * Runs every minute, attempts to send pending emails
     */
    startWorker(intervalMinutes = 1) {
        if (this.processingInterval) {
            console.log('[EmailQueue] Worker already running');
            return;
        }

        console.log(`[EmailQueue] 🚀 Starting email worker (every ${intervalMinutes} minute(s))`);

        const intervalMs = intervalMinutes * 60 * 1000;
        
        // Run immediately on start
        this.processQueue().catch(err => {
            console.error('[EmailQueue] ❌ Initial processing failed:', err.message);
        });

        // Then run periodically
        this.processingInterval = setInterval(() => {
            this.processQueue().catch(err => {
                console.error('[EmailQueue] ❌ Periodic processing failed:', err.message);
            });
        }, intervalMs);
    }

    /**
     * Stop the background worker
     */
    stopWorker() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
            console.log('[EmailQueue] Worker stopped');
        }
    }

    /**
     * Process all pending emails in queue
     */
    async processQueue() {
        if (this.isProcessing) {
            console.log('[EmailQueue] Already processing, skipping...');
            return;
        }

        // Check if email is configured
        if (!this.transporter) {
            console.log('[EmailQueue] ⏳ Email not configured - keeping emails queued');
            return;
        }

        this.isProcessing = true;

        try {
            // Repair legacy rows that exhausted retries but remained PENDING.
            this.db.prepare(`UPDATE event_queue SET status = 'FAILED'
                WHERE status = 'PENDING' AND attempts >= 5
                AND type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT', 'EMAIL_ADMIN_RESET')`).run();
            // Get pending emails (ordered by oldest first)
            const stmt = this.db.prepare(`
                SELECT * FROM event_queue 
                WHERE status = 'PENDING' 
                AND type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT', 'EMAIL_ADMIN_RESET')
                AND attempts < 5
                ORDER BY created_at ASC
                LIMIT 10
            `);

            const pending = stmt.all();

            if (pending.length === 0) {
                console.log('[EmailQueue] ✅ No pending emails');
                return;
            }

            console.log(`[EmailQueue] 📧 Processing ${pending.length} pending email(s)...`);

            let sent = 0;
            let failed = 0;

            for (const event of pending) {
                try {
                    await this._sendEmail(event);
                    sent++;
                } catch (err) {
                    console.error(`[EmailQueue] ❌ Failed to send ${event.event_id}:`, err.message);
                    this._incrementAttempts(event.event_id, err.message, err.permanent === true);
                    failed++;
                }
            }

            console.log(`[EmailQueue] 📊 Summary: ${sent} sent, ${failed} failed`);

        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Send a single email from the queue
     * @private
     */
    async _sendEmail(event) {
        const payload = JSON.parse(event.payload);

        console.log(`[EmailQueue] 📤 Sending ${event.type} for event ${event.event_id}...`);

        // Get customer email from session
        const sessionStmt = this.db.prepare('SELECT customer_data FROM sessions WHERE session_id = ?');
        const session = sessionStmt.get(event.session_id);

        if (!session || !session.customer_data) {
            throw new Error('Session or customer data not found');
        }

        const customerData = JSON.parse(session.customer_data);
        const toEmail = customerData.email;

        if (!toEmail) {
            throw new Error('Customer email not found');
        }

        // Prepare email based on type
        let mailOptions;

        if (event.type === 'EMAIL_ADMIN_RESET') {
            if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) {
                const error = new Error('Recovery code expired; request a new code.');
                error.permanent = true;
                throw error;
            }
            if (typeof payload.text !== 'string' || !payload.text) throw new Error('Recovery email text missing');
            mailOptions = {
                from: process.env.GMAIL_USER,
                to: toEmail,
                subject: 'Admin password reset — your recovery code',
                text: payload.text,
            };
        } else if (event.type === 'EMAIL_REPORT') {
            const pdfBuffer = this._getPdfBuffer(payload, 'Health Report');
            mailOptions = {
                from: process.env.GMAIL_USER,
                to: toEmail,
                subject: `Your Health Report - ${new Date().toLocaleDateString()}`,
                text: `Dear ${customerData.name || 'Customer'},\n\nYour health report from RELIV Kiosk is attached.\n\nBest regards,\nRELIV Team`,
                html: this._generateReportEmailHTML(customerData, payload),
                attachments: [
                    {
                        filename: 'health-report.pdf',
                        content: pdfBuffer
                    }
                ]
            };
        } else if (event.type === 'EMAIL_RECEIPT') {
            const pdfBuffer = this._getPdfBuffer(payload, 'Receipt');
            mailOptions = {
                from: process.env.GMAIL_USER,
                to: toEmail,
                subject: `Payment Receipt - ${new Date().toLocaleDateString()}`,
                text: `Dear ${customerData.name || 'Customer'},\n\nYour payment receipt is attached.\n\nThank you for using RELIV!\n\nBest regards,\nRELIV Team`,
                html: this._generateReceiptEmailHTML(customerData, payload),
                attachments: [
                    {
                        filename: 'receipt.pdf',
                        content: pdfBuffer
                    }
                ]
            };
        } else {
            throw new Error(`Unknown email type: ${event.type}`);
        }

        // Send email
        const result = await this.transporter.sendMail(mailOptions);
        if (Array.isArray(result?.accepted) && result.accepted.length === 0) {
            throw new Error('Mail server did not accept the recipient');
        }

        // Mark as sent
        this._markSent(event.event_id);

        console.log(`[EmailQueue] ✅ Email sent: ${event.event_id} to ${toEmail}`);
    }

    /**
     * Retrieve PDF buffer from payload or filesystem
     * Throws an error if real PDF is unavailable (never substitutes fake content)
     * @private
     */
    _getPdfBuffer(payload, pdfType = 'PDF') {
        let buffer;
        if (payload?.pdfBuffer) {
            buffer = Buffer.from(payload.pdfBuffer);
        } else if (payload?.pdfPath && fs.existsSync(payload.pdfPath)) {
            buffer = fs.readFileSync(payload.pdfPath);
        } else {
            throw new Error(`Real ${pdfType} attachment file not found at path: ${payload?.pdfPath || 'undefined'}`);
        }
        if (buffer.length < 8 || buffer.subarray(0, 5).toString() !== '%PDF-') {
            throw new Error(`Invalid or empty ${pdfType} attachment`);
        }
        return buffer;
    }

    /**
     * Mark email as sent
     * @private
     */
    _markSent(eventId) {
        const stmt = this.db.prepare(`
            UPDATE event_queue 
            SET status = 'COMPLETED', 
                processed_at = datetime('now')
            WHERE event_id = ?
        `);
        stmt.run(eventId);
    }

    /**
     * Increment failed attempt counter
     * @private
     */
    _incrementAttempts(eventId, errorMsg = '', permanent = false) {
        const stmt = this.db.prepare(`
            UPDATE event_queue 
            SET attempts = attempts + 1,
                last_error = ?,
                status = CASE WHEN attempts + 1 >= 5 OR ? = 1 THEN 'FAILED' ELSE 'PENDING' END
            WHERE event_id = ?
        `);
        stmt.run(errorMsg, permanent ? 1 : 0, eventId);
    }

    /**
     * Generate HTML email for report
     * @private
     */
    _generateReportEmailHTML(customerData, payload) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0;">
        <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">
                <tr><td style="background:#172033;padding:28px 40px;text-align:center;border-bottom:3px solid #FF6B1A;">
                    <h1 style="margin:0;color:#ffffff;font-size:26px;letter-spacing:1px;font-weight:700;">RELIV</h1>
                    <p style="margin:6px 0 0;color:#94a3b8;font-size:13px;">Your Personalized Health Checkup</p>
                </td></tr>
                <tr><td style="padding:32px 40px 20px;">
                    <h2 style="margin:0;color:#172033;font-size:18px;font-weight:600;">Dear ${escapeHTML(customerData.name || 'Valued Customer')},</h2>
                    <p style="color:#475569;font-size:14px;line-height:1.6;margin:12px 0 0;">
                        Your comprehensive health report from today's session is attached as an authoritative PDF.
                    </p>
                </td></tr>
                <tr><td style="padding:0 40px 28px;">
                    <p style="color:#64748b;font-size:13px;line-height:1.5;margin:0;">
                        Thank you for choosing Reliv. Proactive health insights for a healthier tomorrow.
                    </p>
                </td></tr>
                <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:12px;">Support: <a href="mailto:relivcustomercare.in@gmail.com" style="color:#FF6B1A;text-decoration:none;font-weight:500;">relivcustomercare.in@gmail.com</a> | Instagram: <a href="https://instagram.com/reliv_care" style="color:#FF6B1A;text-decoration:none;">@reliv_care</a></p>
                    <p style="margin:4px 0 0;color:#94a3b8;font-size:11px;">Generated securely by Reliv Health Kiosk</p>
                </td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>
        `;
    }

    /**
     * Generate HTML email for receipt
     * @private
     */
    _generateReceiptEmailHTML(customerData, payload) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:24px 0;">
        <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.06);border:1px solid #e2e8f0;">
                <tr><td style="background:#172033;padding:28px 40px;text-align:center;border-bottom:3px solid #FF6B1A;">
                    <h1 style="margin:0;color:#ffffff;font-size:26px;letter-spacing:1px;font-weight:700;">RELIV</h1>
                    <p style="margin:6px 0 0;color:#94a3b8;font-size:13px;">Purchase Receipt & Payment Confirmation</p>
                </td></tr>
                <tr><td style="padding:32px 40px 20px;">
                    <h2 style="margin:0;color:#172033;font-size:18px;font-weight:600;">Dear ${escapeHTML(customerData.name || 'Valued Customer')},</h2>
                    <p style="color:#475569;font-size:14px;line-height:1.6;margin:12px 0 0;">
                        Your payment has been successfully verified. Your official purchase receipt is attached as a PDF.
                    </p>
                    <div style="background:#fff5ef;border:1px solid #ffe2d1;border-radius:8px;padding:14px 18px;margin-top:16px;">
                        <span style="color:#667085;font-size:13px;">Total Amount Paid:</span>
                        <strong style="color:#FF6B1A;font-size:16px;margin-left:8px;">₹${payload.amount ? Number(payload.amount).toFixed(2) : '0.00'}</strong>
                    </div>
                </td></tr>
                <tr><td style="padding:0 40px 28px;">
                    <p style="color:#64748b;font-size:13px;line-height:1.5;margin:0;">
                        Thank you for choosing Reliv. This is a digitally generated, authoritative receipt.
                    </p>
                </td></tr>
                <tr><td style="background:#f8fafc;padding:20px 40px;text-align:center;border-top:1px solid #e2e8f0;">
                    <p style="margin:0;color:#64748b;font-size:12px;">Support: <a href="mailto:relivcustomercare.in@gmail.com" style="color:#FF6B1A;text-decoration:none;font-weight:500;">relivcustomercare.in@gmail.com</a> | Instagram: <a href="https://instagram.com/reliv_care" style="color:#FF6B1A;text-decoration:none;">@reliv_care</a></p>
                    <p style="margin:4px 0 0;color:#94a3b8;font-size:11px;">Generated securely by Reliv Health Systems</p>
                </td></tr>
            </table>
        </td></tr>
    </table>
</body>
</html>
        `;
    }

    /**
     * Get queue statistics
     */
    getQueueStats() {
        const stmt = this.db.prepare(`
            SELECT 
                status,
                COUNT(*) as count
            FROM event_queue
            WHERE type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT', 'EMAIL_ADMIN_RESET')
            GROUP BY status
        `);

        const stats = stmt.all();
        const result = {
            pending: 0,
            completed: 0,
            failed: 0
        };

        stats.forEach(row => {
            if (row.status === 'PENDING') result.pending = row.count;
            if (row.status === 'COMPLETED') result.completed = row.count;
            if (row.status === 'FAILED') result.failed = row.count;
        });

        return result;
    }
}

export default EmailQueueService;
