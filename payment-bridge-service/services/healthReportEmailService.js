import crypto from 'crypto';
import {
    createReceiptTransporter,
    isReceiptEmailConfigured,
    normalizeEmail
} from './receiptEmailService.js';
import { generateCloudReceiptPdfBuffer } from './receiptPdfBuilder.js';
import { generateCloudHealthReportPdfBuffer } from './healthReportPdfBuilder.js';
import {
    decryptConfirmationCodeAtRest,
    encryptConfirmationCodeAtRest
} from '../paymentV2Crypto.js';

const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
const inflight = new Map();

const serviceType = (value) => String(value || '').trim().toUpperCase();

function emailKey(email, secret) {
    if (!secret || !String(secret).trim()) {
        const err = new Error('Cloud encryption secret is required');
        err.code = 'PAYMENT_V2_NOT_CONFIGURED';
        throw err;
    }
    return crypto
        .createHmac('sha256', String(secret))
        .update(email, 'utf8')
        .digest('hex');
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function parseSnapshot(ciphertext, secret) {
    if (!ciphertext) {
        const err = new Error('Authoritative health snapshot is unavailable');
        err.code = 'HEALTH_SNAPSHOT_MISSING';
        throw err;
    }

    let parsed;
    try {
        parsed = JSON.parse(decryptConfirmationCodeAtRest(ciphertext, secret));
    } catch (e) {
        const err = new Error(`Stored health snapshot could not be decrypted: ${e.message}`);
        err.code = 'HEALTH_SNAPSHOT_CORRUPT';
        throw err;
    }

    if (
        !parsed ||
        Number(parsed.version) !== 1 ||
        !parsed.patient ||
        !parsed.vitals
    ) {
        const err = new Error('Stored health snapshot structure is invalid');
        err.code = 'HEALTH_SNAPSHOT_CORRUPT';
        throw err;
    }

    return parsed;
}

function requirePaidHealthOrder(db, requestId) {
    if (!requestId || typeof requestId !== 'string') {
        const err = new Error('requestId is required');
        err.code = 'MISSING_REQUEST_ID';
        throw err;
    }

    const normalizedRequestId = requestId.trim();
    const order = db.prepare(
        'SELECT * FROM payment_v2_orders WHERE request_id = ?'
    ).get(normalizedRequestId);

    if (!order) {
        const err = new Error(`Order for request ${normalizedRequestId} not found`);
        err.code = 'ORDER_NOT_FOUND';
        throw err;
    }

    if (order.status !== 'PAID' || !order.razorpay_payment_id) {
        const err = new Error('Health report is available only after captured payment');
        err.code = 'ORDER_NOT_PAID';
        throw err;
    }

    const type = serviceType(order.service_type);
    if (type !== 'HEALTH_CHECKUP' && type !== 'CHECKUP') {
        const err = new Error('This payment does not contain a health checkup report');
        err.code = 'NOT_HEALTH_CHECKUP';
        throw err;
    }

    if (!order.encrypted_health_snapshot) {
        const err = new Error('Paid health order is missing its authoritative health snapshot');
        err.code = 'HEALTH_SNAPSHOT_MISSING';
        throw err;
    }

    return order;
}

function issueDownloadToken(db, scanRow) {
    const token = crypto.randomBytes(24).toString('base64url');
    const hash = tokenHash(token);
    const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;

    db.prepare(`
        UPDATE payment_v2_health_scans
        SET download_token_hash = ?,
            download_token_expires_at = ?,
            updated_at = ?
        WHERE id = ?
    `).run(hash, expiresAt, Date.now(), scanRow.id);

    return { token, expiresAt };
}

function bindScanToEmail({ db, order, normalizedEmail, secret }) {
    const key = emailKey(normalizedEmail, secret);

    const tx = db.transaction(() => {
        const existing = db.prepare(`
            SELECT * FROM payment_v2_health_scans
            WHERE request_id = ?
        `).get(order.request_id);

        if (existing) {
            if (existing.email_key !== key) {
                const err = new Error(
                    'This paid health scan is already bound to a different delivery email'
                );
                err.code = 'REPORT_EMAIL_ALREADY_BOUND';
                throw err;
            }
            return existing;
        }

        const maxRow = db.prepare(`
            SELECT COALESCE(MAX(scan_number), 0) AS max_scan
            FROM payment_v2_health_scans
            WHERE email_key = ?
        `).get(key);

        const scanNumber = Number(maxRow?.max_scan || 0) + 1;
        const now = Date.now();
        const encryptedEmail = encryptConfirmationCodeAtRest(normalizedEmail, secret);

        db.prepare(`
            INSERT INTO payment_v2_health_scans (
                request_id,
                order_id,
                transaction_id,
                email_key,
                encrypted_email,
                scan_number,
                encrypted_snapshot,
                delivery_status,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
        `).run(
            order.request_id,
            order.order_id,
            order.transaction_id,
            key,
            encryptedEmail,
            scanNumber,
            order.encrypted_health_snapshot,
            now,
            now
        );

        return db.prepare(`
            SELECT * FROM payment_v2_health_scans
            WHERE request_id = ?
        `).get(order.request_id);
    });

    return tx();
}

function loadHistory(db, key, secret) {
    const rows = db.prepare(`
        SELECT *
        FROM payment_v2_health_scans
        WHERE email_key = ?
        ORDER BY scan_number ASC
    `).all(key);

    return rows.map(row => ({
        scanNumber: Number(row.scan_number),
        requestId: row.request_id,
        orderId: row.order_id,
        createdAt: Number(row.created_at),
        snapshot: parseSnapshot(row.encrypted_snapshot, secret)
    }));
}

function reportEmailContent({ scanNumber, totalScans, patientName }) {
    const safeName = patientName || 'there';
    const text = `Hi ${safeName},

Your Reliv Health Report is ready.

Health Check: Scan ${scanNumber}
Scans linked to this history: ${totalScans}

Your PDF health report is attached to this email. A payment receipt is also attached when available.

This report is for wellness tracking and informational use. It is not a diagnosis or substitute for professional medical advice.

Reliv Health
relivcustomercare.in@gmail.com`;

    const html = `<!doctype html>
<html>
<body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#172033">
  <div style="max-width:560px;margin:32px auto;background:white;border:1px solid #e4e7ec;border-radius:16px;overflow:hidden">
    <div style="padding:28px;background:#172033;color:white">
      <div style="font-size:22px;font-weight:800;letter-spacing:1px">RELIV</div>
      <div style="margin-top:6px;color:#d0d5dd">Your Health Report is ready</div>
    </div>
    <div style="padding:28px">
      <p style="margin-top:0">Hi ${safeName},</p>
      <p>Your latest Reliv health report has been generated securely.</p>
      <div style="background:#fff4ed;border:1px solid #ffd7bf;border-radius:12px;padding:16px;margin:20px 0">
        <strong style="color:#ff641a">Scan ${scanNumber}</strong><br>
        <span style="font-size:13px;color:#667085">${totalScans} paid scan${totalScans === 1 ? '' : 's'} linked to this history</span>
      </div>
      <p>The PDF health report is attached. A payment receipt is also attached when available.</p>
      <p style="font-size:12px;color:#667085;line-height:1.6">
        This report is intended for wellness tracking and informational use. It is not a diagnosis,
        medical prescription, or substitute for professional medical evaluation.
      </p>
    </div>
  </div>
</body>
</html>`;

    return { text, html };
}

export async function sendHealthReportEmail({
    db,
    requestId,
    email,
    codeSecret,
    transporter = null,
    reportPdfBuilderOverride = null,
    receiptPdfBuilderOverride = null
}) {
    const key = String(requestId || '').trim();

    if (inflight.has(key)) {
        return await inflight.get(key);
    }

    const task = (async () => {
        const order = requirePaidHealthOrder(db, requestId);
        const normalizedEmail = normalizeEmail(email);
        const keyForEmail = emailKey(normalizedEmail, codeSecret);

        let scanRow = bindScanToEmail({
            db,
            order,
            normalizedEmail,
            secret: codeSecret
        });

        // Idempotent success: do not send the same scan email twice.
        if (scanRow.delivery_status === 'SENT') {
            const dl = issueDownloadToken(db, scanRow);
            return {
                ok: true,
                sent: true,
                alreadySent: true,
                requestId: order.request_id,
                email: normalizedEmail,
                scanNumber: Number(scanRow.scan_number),
                downloadToken: dl.token,
                downloadTokenExpiresAt: dl.expiresAt
            };
        }

        const history = loadHistory(db, keyForEmail, codeSecret);
        const current = history.find(s => s.requestId === order.request_id);

        if (!current) {
            const err = new Error('Current paid scan is missing from report history');
            err.code = 'HEALTH_HISTORY_CORRUPT';
            throw err;
        }

        let healthPdf;
        try {
            const builder = reportPdfBuilderOverride || generateCloudHealthReportPdfBuffer;
            healthPdf = await builder({
                scans: history,
                currentScanNumber: current.scanNumber,
                recipientEmail: normalizedEmail
            });

            if (!Buffer.isBuffer(healthPdf) || healthPdf.length < 500) {
                throw new Error('Health report PDF generator returned an invalid buffer');
            }
        } catch (e) {
            db.prepare(`
                UPDATE payment_v2_health_scans
                SET delivery_status = 'FAILED',
                    last_error = ?,
                    updated_at = ?
                WHERE request_id = ?
            `).run(`PDF generation failed: ${e.message}`, Date.now(), order.request_id);

            const err = new Error(`Failed to generate health report PDF: ${e.message}`);
            err.code = 'HEALTH_REPORT_GENERATION_FAILED';
            throw err;
        }

        // Receipt is useful, but report delivery must not fail just because receipt PDF generation failed.
        let receiptPdf = null;
        try {
            const receiptBuilder = receiptPdfBuilderOverride || generateCloudReceiptPdfBuffer;
            receiptPdf = await receiptBuilder(order, normalizedEmail);
            if (!Buffer.isBuffer(receiptPdf)) receiptPdf = null;
        } catch (e) {
            console.warn(`[HealthReportEmail] Receipt PDF skipped for ${order.request_id}: ${e.message}`);
            receiptPdf = null;
        }

        let mailTransporter = transporter;
        if (!mailTransporter) {
            if (!isReceiptEmailConfigured()) {
                const err = new Error('Health report email service is not configured');
                err.code = 'EMAIL_SERVICE_NOT_CONFIGURED';
                throw err;
            }
            mailTransporter = createReceiptTransporter();
        }

        const patientName = current.snapshot?.patient?.name || order.customer_name || '';
        const body = reportEmailContent({
            scanNumber: current.scanNumber,
            totalScans: history.length,
            patientName
        });

        const attachments = [{
            filename: `Reliv-Health-Report-Scan-${current.scanNumber}.pdf`,
            content: healthPdf,
            contentType: 'application/pdf'
        }];

        if (receiptPdf) {
            attachments.push({
                filename: `Reliv-Payment-Receipt-${order.request_id.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`,
                content: receiptPdf,
                contentType: 'application/pdf'
            });
        }

        try {
            const info = await mailTransporter.sendMail({
                from: `"${process.env.RECEIPT_FROM_NAME || 'Reliv Health'}" <${process.env.RECEIPT_GMAIL_USER || 'no-reply@reliv.in'}>`,
                to: normalizedEmail,
                subject: `Your Reliv Health Report â€” Scan ${current.scanNumber}`,
                text: body.text,
                html: body.html,
                attachments
            });

            const sentAt = Date.now();
            const messageId = info?.messageId || `health_${sentAt}_${order.request_id}`;

            db.prepare(`
                UPDATE payment_v2_health_scans
                SET delivery_status = 'SENT',
                    message_id = ?,
                    sent_at = ?,
                    last_error = NULL,
                    updated_at = ?
                WHERE request_id = ?
            `).run(messageId, sentAt, sentAt, order.request_id);

            scanRow = db.prepare(`
                SELECT * FROM payment_v2_health_scans
                WHERE request_id = ?
            `).get(order.request_id);

            const dl = issueDownloadToken(db, scanRow);

            return {
                ok: true,
                sent: true,
                alreadySent: false,
                requestId: order.request_id,
                email: normalizedEmail,
                scanNumber: current.scanNumber,
                totalScans: history.length,
                messageId,
                sentAt,
                downloadToken: dl.token,
                downloadTokenExpiresAt: dl.expiresAt
            };
        } catch (e) {
            db.prepare(`
                UPDATE payment_v2_health_scans
                SET delivery_status = 'FAILED',
                    last_error = ?,
                    updated_at = ?
                WHERE request_id = ?
            `).run(e.message || 'Unknown email error', Date.now(), order.request_id);

            const err = new Error(`Failed to email health report: ${e.message}`);
            err.code = 'EMAIL_SEND_FAILED';
            throw err;
        }
    })();

    inflight.set(key, task);
    try {
        return await task;
    } finally {
        inflight.delete(key);
    }
}

export async function generateHealthReportDownload({
    db,
    requestId,
    token,
    codeSecret
}) {
    if (!requestId || !token) {
        const err = new Error('requestId and download token are required');
        err.code = 'INVALID_DOWNLOAD_TOKEN';
        throw err;
    }

    const order = requirePaidHealthOrder(db, requestId);
    const row = db.prepare(`
        SELECT * FROM payment_v2_health_scans
        WHERE request_id = ?
    `).get(order.request_id);

    if (!row || row.delivery_status !== 'SENT') {
        const err = new Error('Health report has not been successfully delivered yet');
        err.code = 'REPORT_NOT_SENT';
        throw err;
    }

    if (
        !row.download_token_hash ||
        !row.download_token_expires_at ||
        Date.now() > Number(row.download_token_expires_at)
    ) {
        const err = new Error('Health report download token has expired');
        err.code = 'DOWNLOAD_TOKEN_EXPIRED';
        throw err;
    }

    const provided = Buffer.from(tokenHash(token), 'hex');
    const expected = Buffer.from(row.download_token_hash, 'hex');

    if (
        provided.length !== expected.length ||
        !crypto.timingSafeEqual(provided, expected)
    ) {
        const err = new Error('Invalid health report download token');
        err.code = 'INVALID_DOWNLOAD_TOKEN';
        throw err;
    }

    const history = loadHistory(db, row.email_key, codeSecret);
    const normalizedEmail = decryptConfirmationCodeAtRest(row.encrypted_email, codeSecret);

    const pdf = await generateCloudHealthReportPdfBuffer({
        scans: history,
        currentScanNumber: Number(row.scan_number),
        recipientEmail: normalizedEmail
    });

    return {
        ok: true,
        requestId: row.request_id,
        scanNumber: Number(row.scan_number),
        pdf
    };
}

export default {
    sendHealthReportEmail,
    generateHealthReportDownload
};