import fs from 'fs';

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
        const eventId = `EVT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        const stmt = this.db.prepare(`
            INSERT INTO event_queue (
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
            // Get pending emails (ordered by oldest first)
            const stmt = this.db.prepare(`
                SELECT * FROM event_queue 
                WHERE status = 'PENDING' 
                AND type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT')
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
                    this._incrementAttempts(event.event_id, err.message);
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

        if (event.type === 'EMAIL_REPORT') {
            mailOptions = {
                from: process.env.GMAIL_USER,
                to: toEmail,
                subject: `Your Health Report - ${new Date().toLocaleDateString()}`,
                text: `Dear ${customerData.name || 'Customer'},\n\nYour health report from RELIV Kiosk is attached.\n\nBest regards,\nRELIV Team`,
                html: this._generateReportEmailHTML(customerData, payload),
                attachments: [
                    {
                        filename: 'health-report.pdf',
                        content: payload.pdfBuffer ? Buffer.from(payload.pdfBuffer) : (fs.existsSync(payload.pdfPath) ? fs.readFileSync(payload.pdfPath) : Buffer.from('Mock PDF Content'))
                    }
                ]
            };
        } else if (event.type === 'EMAIL_RECEIPT') {
            mailOptions = {
                from: process.env.GMAIL_USER,
                to: toEmail,
                subject: `Payment Receipt - ${new Date().toLocaleDateString()}`,
                text: `Dear ${customerData.name || 'Customer'},\n\nYour payment receipt is attached.\n\nThank you for using RELIV!\n\nBest regards,\nRELIV Team`,
                html: this._generateReceiptEmailHTML(customerData, payload),
                attachments: [
                    {
                        filename: 'receipt.pdf',
                        content: payload.pdfBuffer ? Buffer.from(payload.pdfBuffer) : (fs.existsSync(payload.pdfPath) ? fs.readFileSync(payload.pdfPath) : Buffer.from('Mock PDF Content'))
                    }
                ]
            };
        } else {
            throw new Error(`Unknown email type: ${event.type}`);
        }

        // Send email
        await this.transporter.sendMail(mailOptions);

        // Mark as sent
        this._markSent(event.event_id);

        console.log(`[EmailQueue] ✅ Email sent: ${event.event_id} to ${toEmail}`);
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
    _incrementAttempts(eventId, errorMsg = '') {
        const stmt = this.db.prepare(`
            UPDATE event_queue 
            SET attempts = attempts + 1,
                last_error = ?
            WHERE event_id = ?
        `);
        stmt.run(errorMsg, eventId);
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
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;">
        <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
                <tr><td style="background:#F97316;padding:30px 40px;text-align:center;">
                    <h1 style="margin:0;color:#fff;font-size:28px;">RELIV</h1>
                    <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:14px;">Your Health Report</p>
                </td></tr>
                <tr><td style="padding:30px 40px;">
                    <h2 style="margin:0;color:#111;font-size:20px;">Hi ${customerData.name || 'Customer'},</h2>
                    <p style="color:#555;font-size:14px;line-height:1.6;margin:10px 0 0;">
                        Your health report from today's checkup is attached as a PDF.
                    </p>
                </td></tr>
                <tr><td style="padding:0 40px 30px;">
                    <p style="color:#555;font-size:13px;line-height:1.5;margin:0;">
                        Thank you for using RELIV. Stay healthy!
                    </p>
                </td></tr>
                <tr><td style="background:#f9f9f9;padding:20px 40px;text-align:center;">
                    <p style="margin:0;color:#999;font-size:12px;">Generated by RELIV Kiosk</p>
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
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;">
        <tr><td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
                <tr><td style="background:#F97316;padding:30px 40px;text-align:center;">
                    <h1 style="margin:0;color:#fff;font-size:28px;">RELIV</h1>
                    <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:14px;">Payment Receipt</p>
                </td></tr>
                <tr><td style="padding:30px 40px;">
                    <h2 style="margin:0;color:#111;font-size:20px;">Hi ${customerData.name || 'Customer'},</h2>
                    <p style="color:#555;font-size:14px;line-height:1.6;margin:10px 0 0;">
                        Your payment receipt is attached. Thank you for your payment!
                    </p>
                </td></tr>
                <tr><td style="padding:0 40px 30px;">
                    <p style="color:#555;font-size:13px;line-height:1.5;margin:0;">
                        Amount: ₹${payload.amount ? payload.amount.toFixed(2) : 'N/A'}
                    </p>
                </td></tr>
                <tr><td style="background:#f9f9f9;padding:20px 40px;text-align:center;">
                    <p style="margin:0;color:#999;font-size:12px;">Thank you for using RELIV!</p>
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
            WHERE type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT')
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
