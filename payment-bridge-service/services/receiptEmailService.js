/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - RECEIPT EMAIL SERVICE
 * Purpose: Authoritative email receipt dispatch via Nodemailer & Gmail SMTP
 *          with duplicate protection, audit logging, and strict data integrity.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import nodemailer from 'nodemailer';
import { generateCloudReceiptPdfBuffer } from './receiptPdfBuilder.js';

export { generateCloudReceiptPdfBuffer };

/**
 * Check if Gmail SMTP credentials are configured
 * @returns {boolean}
 */
export function isReceiptEmailConfigured() {
    const user = process.env.RECEIPT_GMAIL_USER;
    const pass = process.env.RECEIPT_GMAIL_APP_PASSWORD;
    return Boolean(user && String(user).trim() && pass && String(pass).trim());
}

/**
 * Create Nodemailer transporter for Gmail SMTP
 * @param {Object} [configOverride]
 * @returns {import('nodemailer').Transporter}
 */
export function createReceiptTransporter(configOverride = {}) {
    const user = configOverride.user || process.env.RECEIPT_GMAIL_USER;
    const pass = configOverride.pass || process.env.RECEIPT_GMAIL_APP_PASSWORD;

    return nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user,
            pass
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    });
}

/**
 * Format service type into human-friendly label
 * @param {string} serviceType
 * @returns {string}
 */
export function formatServiceType(serviceType) {
    if (!serviceType) return 'Medicine Purchase';
    const normalized = String(serviceType).toUpperCase();
    if (normalized === 'MEDICINE_PURCHASE' || normalized === 'MEDICINE') {
        return 'Medicine Purchase';
    }
    if (normalized === 'HEALTH_CHECKUP' || normalized === 'CHECKUP') {
        return 'Health Checkup';
    }
    // Convert SNAKE_CASE to Title Case
    return String(serviceType)
        .split(/[_\s]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Format amount in paise to Rupee string (e.g. ₹37.84 or ₹500.00)
 * @param {number} amountInPaise
 * @param {string} [currency='INR']
 * @returns {string}
 */
export function formatAmount(amountInPaise, currency = 'INR') {
    const amountNum = Number(amountInPaise) || 0;
    const inRupees = (amountNum / 100).toFixed(2);
    return currency === 'INR' ? `₹${inRupees}` : `${currency} ${inRupees}`;
}

/**
 * Normalize and validate email address
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmail(email) {
    if (!email || typeof email !== 'string') {
        const err = new Error('Recipient email is required');
        err.code = 'MISSING_EMAIL';
        throw err;
    }
    const normalized = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalized) || normalized.length > 254) {
        const err = new Error('Invalid recipient email address format');
        err.code = 'INVALID_EMAIL';
        throw err;
    }
    return normalized;
}

/**
 * Generate HTML and plain text receipt body for an authoritative order
 *
 * NOTE: Kiosk 4-digit confirmation code is NEVER included.
 * NOTE: No made-up GST or item breakdown is included.
 *
 * @param {Object} order
 * @returns {{ text: string, html: string, formattedAmount: string, serviceLabel: string }}
 */
export function generateReceiptContent(order) {
    const formattedAmount = formatAmount(order.amount, order.currency || 'INR');
    const serviceLabel = formatServiceType(order.service_type || order.serviceType);
    const dateFormatted = order.verified_at
        ? new Date(order.verified_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }) + ' IST'
        : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }) + ' IST';

    let itemsDetailText = '';
    let itemsDetailHtml = '';

    if (order.cart) {
        try {
            const parsed = typeof order.cart === 'string' ? JSON.parse(order.cart) : order.cart;
            if (Array.isArray(parsed) && parsed.length > 0) {
                itemsDetailText = '\nItems Purchased:\n' + parsed.map(item => {
                    const name = item.name || item.item_name || item.medicine_name || item.kit_id || 'Medicine Item';
                    const qty = item.quantity || item.qty || item.cartQuantity || 1;
                    return ` - ${name} (Qty: ${qty})`;
                }).join('\n') + '\n';

                itemsDetailHtml = `
          <tr>
            <td class="detail-label">Items</td>
            <td class="detail-value" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
              ${parsed.map(item => {
                  const name = item.name || item.item_name || item.medicine_name || item.kit_id || 'Medicine Item';
                  const qty = item.quantity || item.qty || item.cartQuantity || 1;
                  return `<div>• ${name} &times; ${qty}</div>`;
              }).join('')}
            </td>
          </tr>`;
            }
        } catch (e) {}
    } else if (order.item_name) {
        itemsDetailText = `\nItem: ${order.item_name}\n`;
        itemsDetailHtml = `
          <tr>
            <td class="detail-label">Item</td>
            <td class="detail-value" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${order.item_name}</td>
          </tr>`;
    }

    const text = `========================================
RELIV
Payment Receipt
========================================

Payment Successful

Amount Paid: ${formattedAmount}
Status: PAID
Service: ${serviceLabel}${itemsDetailText}
Payment ID: ${order.razorpay_payment_id || 'N/A'}
Order ID: ${order.order_id || 'N/A'}
Transaction ID: ${order.transaction_id || 'N/A'}
Receipt ID: ${order.request_id || 'N/A'}

Payment Gateway: Razorpay
Date: ${dateFormatted}

========================================
Thank you for using Reliv Health.
For queries, contact relivcustomercare.in@gmail.com
========================================`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reliv Payment Receipt</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f4f6f8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f4f6f8;
      padding: 32px 16px;
      box-sizing: border-box;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
      border: 1px solid #e2e8f0;
    }
    .header {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      padding: 28px 24px;
      text-align: center;
      color: #ffffff;
    }
    .brand-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 2px;
      color: #38bdf8;
      margin: 0 0 4px 0;
      text-transform: uppercase;
    }
    .brand-subtitle {
      font-size: 13px;
      color: #94a3b8;
      margin: 0;
      font-weight: 500;
      letter-spacing: 0.5px;
    }
    .status-section {
      text-align: center;
      padding: 24px 24px 16px 24px;
    }
    .status-badge {
      display: inline-block;
      background-color: #ecfdf5;
      color: #059669;
      font-size: 13px;
      font-weight: 700;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid #a7f3d0;
      margin-bottom: 12px;
    }
    .amount-display {
      font-size: 32px;
      font-weight: 800;
      color: #0f172a;
      margin: 4px 0 0 0;
    }
    .receipt-details {
      padding: 16px 24px 24px 24px;
    }
    .detail-table {
      width: 100%;
      border-collapse: collapse;
    }
    .detail-table tr {
      border-bottom: 1px solid #f1f5f9;
    }
    .detail-table tr:last-child {
      border-bottom: none;
    }
    .detail-label {
      padding: 10px 0;
      font-size: 13px;
      color: #64748b;
      font-weight: 500;
      text-align: left;
    }
    .detail-value {
      padding: 10px 0;
      font-size: 13px;
      color: #0f172a;
      font-weight: 600;
      text-align: right;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      word-break: break-all;
    }
    .status-pill {
      background-color: #dcfce7;
      color: #166534;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 24px;
      text-align: center;
      border-top: 1px solid #e2e8f0;
      font-size: 12px;
      color: #94a3b8;
      line-height: 1.5;
    }
    .footer a {
      color: #0284c7;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="brand-title">RELIV</div>
        <div class="brand-subtitle">Smart Health Systems • Payment Receipt</div>
      </div>
      <div class="status-section">
        <span class="status-badge">✓ Payment Successful</span>
        <div class="amount-display">${formattedAmount}</div>
      </div>
      <div class="receipt-details">
        <table class="detail-table">
          <tr>
            <td class="detail-label">Status</td>
            <td class="detail-value"><span class="status-pill">PAID</span></td>
          </tr>
          <tr>
            <td class="detail-label">Service</td>
            <td class="detail-value" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${serviceLabel}</td>
          </tr>${itemsDetailHtml}
          <tr>
            <td class="detail-label">Payment ID</td>
            <td class="detail-value">${order.razorpay_payment_id || 'N/A'}</td>
          </tr>
          <tr>
            <td class="detail-label">Order ID</td>
            <td class="detail-value">${order.order_id || 'N/A'}</td>
          </tr>
          <tr>
            <td class="detail-label">Transaction ID</td>
            <td class="detail-value">${order.transaction_id || 'N/A'}</td>
          </tr>
          <tr>
            <td class="detail-label">Receipt ID</td>
            <td class="detail-value">${order.request_id || 'N/A'}</td>
          </tr>
          <tr>
            <td class="detail-label">Payment Gateway</td>
            <td class="detail-value" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Razorpay</td>
          </tr>
          <tr>
            <td class="detail-label">Date & Time</td>
            <td class="detail-value" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${dateFormatted}</td>
          </tr>
        </table>
      </div>
      <div class="footer">
        This is an authoritative receipt generated by Reliv Health.<br>
        If you have any questions, reach out to <a href="mailto:relivcustomercare.in@gmail.com">relivcustomercare.in@gmail.com</a>.<br>
        &copy; ${new Date().getFullYear()} Reliv Health. All rights reserved.
      </div>
    </div>
  </div>
</body>
</html>`;

    return {
        text,
        html,
        formattedAmount,
        serviceLabel
    };
}

/**
 * Send authoritative payment receipt email with duplicate protection & audit logging
 *
 * @param {Object} params
 * @param {import('better-sqlite3').Database} params.db - SQLite DB instance
 * @param {Object} params.order - Authoritative order from payment_v2_orders
 * @param {string} params.email - Recipient email
 * @param {import('nodemailer').Transporter} [params.transporter] - Optional transporter override
 * @param {Function} [params.pdfBuilderOverride] - Optional PDF builder override for testing
 * @returns {Promise<Object>}
 */
export async function sendPaymentReceipt({ db, order, email, transporter = null, pdfBuilderOverride = null }) {
    if (!db) {
        throw new Error('Database connection is required to send receipt');
    }

    if (!order) {
        const err = new Error('Authoritative order is required');
        err.code = 'ORDER_REQUIRED';
        throw err;
    }

    // 1. Authoritative order validation: Must be PAID and have razorpay_payment_id
    if (order.status !== 'PAID' || !order.razorpay_payment_id) {
        console.warn(`[ReceiptEmail] ⚠️ Rejection: Order ${order.order_id || order.request_id} is not PAID (status: ${order.status})`);
        const err = new Error('Receipt cannot be generated for an unpaid order');
        err.code = 'ORDER_NOT_PAID';
        throw err;
    }

    // 2. Email normalization and strict validation
    const normalizedEmail = normalizeEmail(email);
    const requestId = order.request_id;

    // 3. Duplicate protection: Prevent repeated successful emails for requestId + normalizedEmail
    const existingSuccessful = db.prepare(`
        SELECT * FROM payment_v2_receipts
        WHERE request_id = ? AND email = ? AND status = 'SENT'
        ORDER BY sent_at DESC LIMIT 1
    `).get(requestId, normalizedEmail);

    if (existingSuccessful) {
        console.log(`[ReceiptEmail] ℹ️ Duplicate receipt requested for request ${requestId} to ${normalizedEmail} — already sent at ${existingSuccessful.sent_at}`);
        return {
            ok: true,
            sent: true,
            alreadySent: true,
            messageId: existingSuccessful.message_id,
            sentAt: existingSuccessful.sent_at,
            email: normalizedEmail,
            requestId
        };
    }

    // 4. Check configuration if no transporter is provided
    let mailTransporter = transporter;
    if (!mailTransporter) {
        if (!isReceiptEmailConfigured()) {
            console.error('[ReceiptEmail] ❌ Receipt email service is not configured (missing RECEIPT_GMAIL_USER or RECEIPT_GMAIL_APP_PASSWORD)');
            const err = new Error('Receipt email service is not configured');
            err.code = 'EMAIL_SERVICE_NOT_CONFIGURED';
            throw err;
        }
        mailTransporter = createReceiptTransporter();
    }

    // 5. Insert PENDING audit record in payment_v2_receipts
    const createdAt = Date.now();
    const insertStmt = db.prepare(`
        INSERT INTO payment_v2_receipts (request_id, email, status, created_at)
        VALUES (?, ?, 'PENDING', ?)
    `);
    const insertRes = insertStmt.run(requestId, normalizedEmail, createdAt);
    const receiptLogId = insertRes.lastInsertRowid;

    // 6. Generate authoritative receipt content
    const { text, html, formattedAmount } = generateReceiptContent(order);

    // 7. Generate PDF receipt buffer
    let pdfBuffer;
    try {
        const builderFn = pdfBuilderOverride || generateCloudReceiptPdfBuffer;
        pdfBuffer = await builderFn(order, normalizedEmail);
        if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
            throw new Error('PDF generator returned an invalid or empty buffer');
        }
    } catch (pdfErr) {
        console.error(`[ReceiptEmail] ❌ Failed to generate PDF receipt for request ${requestId}:`, pdfErr.message);

        db.prepare(`
            UPDATE payment_v2_receipts
            SET status = 'FAILED',
                last_error = ?
            WHERE id = ?
        `).run(`PDF Generation Failed: ${pdfErr.message}`, receiptLogId);

        const err = new Error(`Failed to generate receipt PDF: ${pdfErr.message}`);
        err.code = 'EMAIL_RECEIPT_GENERATION_FAILED';
        throw err;
    }

    const fromName = process.env.RECEIPT_FROM_NAME || 'Reliv Health';
    const fromUser = process.env.RECEIPT_GMAIL_USER || 'no-reply@reliv.in';
    const safeReceiptId = String(order.request_id || order.order_id || 'RECEIPT').replace(/[^a-zA-Z0-9_-]/g, '_');

    const mailOptions = {
        from: `"${fromName}" <${fromUser}>`,
        to: normalizedEmail,
        subject: `Payment Receipt: ${formattedAmount} - ${requestId}`,
        text,
        html,
        attachments: [
            {
                filename: `Reliv-Receipt-${safeReceiptId}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }
        ]
    };

    // 8. Dispatch email via Nodemailer
    try {
        const info = await mailTransporter.sendMail(mailOptions);
        const sentAt = Date.now();
        const messageId = info.messageId || `msg_${sentAt}_${requestId}`;

        db.prepare(`
            UPDATE payment_v2_receipts
            SET status = 'SENT',
                message_id = ?,
                sent_at = ?
            WHERE id = ?
        `).run(messageId, sentAt, receiptLogId);

        console.log(`[ReceiptEmail] ✅ Payment receipt sent with PDF for request ${requestId} to ${normalizedEmail} (MessageId: ${messageId})`);

        return {
            ok: true,
            sent: true,
            alreadySent: false,
            messageId,
            sentAt,
            email: normalizedEmail,
            requestId
        };

    } catch (sendErr) {
        console.error(`[ReceiptEmail] ❌ Failed to send receipt for request ${requestId} to ${normalizedEmail}:`, sendErr.message);

        db.prepare(`
            UPDATE payment_v2_receipts
            SET status = 'FAILED',
                last_error = ?
            WHERE id = ?
        `).run(sendErr.message || 'Unknown send error', receiptLogId);

        const err = new Error(`Failed to send email receipt: ${sendErr.message}`);
        err.code = 'EMAIL_SEND_FAILED';
        throw err;
    }
}

export default {
    isReceiptEmailConfigured,
    createReceiptTransporter,
    formatServiceType,
    formatAmount,
    normalizeEmail,
    generateReceiptContent,
    generateCloudReceiptPdfBuffer,
    sendPaymentReceipt
};
