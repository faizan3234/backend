/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - RECEIPT PDF BUILDER
 * Purpose: Generates authoritative A4 payment receipt PDFs in-memory for
 *          Cloud Payment V2 email attachments.
 * 
 * SECURITY & DATA INTEGRITY RULES:
 * 1. ONLY authoritative database/order data is rendered.
 * 2. Client-provided fields (amount, status, IDs, items, codes) are NEVER trusted.
 * 3. 4-digit kiosk confirmation code is STRICTLY EXCLUDED.
 * 4. Phone numbers are NEVER collected or fabricated.
 * 5. If itemized cart is not in the authoritative record, renders authoritative
 *    service type and total without inventing line items or taxes.
 * 6. Returns an in-memory Buffer with zero local disk leakage.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Format service type into a clean, human-friendly title
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
    return String(serviceType)
        .split(/[_\s]+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

/**
 * Format date as "23 August 2026"
 * @param {number|string|Date} dateInput
 * @returns {string}
 */
export function formatReceiptDate(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
}

/**
 * Format date & time as "23 August 2026, 03:45 PM"
 * @param {number|string|Date} dateInput
 * @returns {string}
 */
export function formatReceiptDateTime(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    const datePart = formatReceiptDate(d);
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${datePart}, ${hours}:${minutes} ${ampm}`;
}

/**
 * Resolve asset file path safely across environments
 * @param {string} relativePath
 * @returns {string|null}
 */
function resolveAssetPath(relativePath) {
    const candidatePaths = [
        path.join(__dirname, '..', relativePath),
        path.join(__dirname, '../..', relativePath),
        path.join(process.cwd(), relativePath),
        path.join(process.cwd(), 'payment-bridge-service', relativePath)
    ];

    for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Setup TrueType fonts supporting the Indian Rupee (₹) symbol
 * @param {PDFDocument} doc
 * @returns {{ fontRegular: string, fontBold: string, currencySymbol: string }}
 */
export function setupPdfFonts(doc) {
    let hasBold = false;
    let hasRegular = false;

    // Check DejaVuSans-Bold TrueType font in bridge or project
    const fontPath = resolveAssetPath('fonts/DejaVuSans-Bold.ttf');
    if (fontPath) {
        try {
            doc.registerFont('Reliv-Bold', fontPath);
            hasBold = true;
        } catch (e) {
            console.warn('[ReceiptPdfBuilder] Could not register DejaVuSans-Bold:', e.message);
        }
    }

    // Windows fallback fonts if running on Windows
    if (process.platform === 'win32') {
        const arialPath = 'C:/Windows/Fonts/arial.ttf';
        const arialBoldPath = 'C:/Windows/Fonts/arialbd.ttf';
        if (fs.existsSync(arialPath)) {
            try {
                doc.registerFont('Reliv-Regular', arialPath);
                hasRegular = true;
                if (!hasBold && fs.existsSync(arialBoldPath)) {
                    doc.registerFont('Reliv-Bold', arialBoldPath);
                    hasBold = true;
                }
            } catch (e) {}
        }
    }

    return {
        fontRegular: hasRegular ? 'Reliv-Regular' : (hasBold ? 'Reliv-Bold' : 'Helvetica'),
        fontBold: hasBold ? 'Reliv-Bold' : 'Helvetica-Bold',
        currencySymbol: hasBold ? '₹' : 'INR '
    };
}

/**
 * Build authoritative receipt dataset strictly from Cloud Payment V2 order record
 * @param {Object} order - Authoritative payment_v2_orders row
 * @param {string} recipientEmail - Normalized recipient email
 * @returns {Object}
 */
export function normalizeCloudReceiptData(order, recipientEmail) {
    if (!order) {
        throw new Error('Authoritative order record is required');
    }

    const rawAmount = Number(order.amount) || 0;
    const amountInRupees = rawAmount / 100;
    const paidTimestamp = order.verified_at || order.created_at || Date.now();
    const serviceLabel = formatServiceType(order.service_type);

    // Customer Name: only if genuinely present in order record
    const customerName = order.customer_name || order.customerName || null;

    // Check if authoritative cart snapshot exists
    let cartItems = null;
    if (order.cart) {
        try {
            const parsed = typeof order.cart === 'string' ? JSON.parse(order.cart) : order.cart;
            if (Array.isArray(parsed) && parsed.length > 0) {
                cartItems = parsed.map(item => ({
                    name: item.name || item.item_name || item.medicine_name || item.kit_id || 'Medicine Item',
                    qty: Number(item.cartQuantity || item.quantity || 1),
                    unitPrice: Number(item.price || item.unit_price || 0),
                    total: Number(item.total || ((item.price || 0) * (item.quantity || 1)))
                }));
            }
        } catch (e) {
            cartItems = null;
        }
    }

    return {
        receiptId: order.request_id || order.order_id || 'RLV-RECEIPT',
        requestId: order.request_id || 'N/A',
        orderId: order.order_id || 'N/A',
        paymentId: order.razorpay_payment_id || 'N/A',
        transactionId: order.transaction_id || 'N/A',
        sessionId: order.session_id || 'N/A',
        kioskId: order.kiosk_id || 'N/A',
        serviceType: serviceLabel,
        amountInRupees,
        currency: order.currency || 'INR',
        status: 'PAID',
        paidAt: paidTimestamp,
        customerName,
        recipientEmail: String(recipientEmail || '').trim().toLowerCase(),
        cartItems
    };
}

/**
 * Generate an A4 Reliv Payment Receipt PDF in memory
 * 
 * @param {Object} order - Authoritative order from database
 * @param {string} recipientEmail - Recipient email
 * @returns {Promise<Buffer>}
 */
export async function generateCloudReceiptPdfBuffer(order, recipientEmail) {
    return new Promise((resolve, reject) => {
        try {
            const data = normalizeCloudReceiptData(order, recipientEmail);
            const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
            const chunks = [];

            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const { fontRegular, fontBold, currencySymbol } = setupPdfFonts(doc);

            const pageWidth = 595.28;
            const pageHeight = 841.89;
            const margin = 44;
            const contentWidth = pageWidth - (margin * 2);

            // ── 1. Header Card ──────────────────────────────────────────
            const headerY = 40;
            const headerH = 100;
            doc.roundedRect(margin, headerY, contentWidth, headerH, 10).fillAndStroke('#FFF5EF', '#FFE2D1');

            // Logo
            const logoPath = resolveAssetPath('assets/reliv.png') || resolveAssetPath('reliv.png');
            if (logoPath) {
                try {
                    doc.image(logoPath, margin + 14, headerY + 14, { height: 44 });
                } catch (e) {
                    doc.font(fontBold).fontSize(26).fillColor('#FF6B1A').text('RELIV', margin + 14, headerY + 16);
                }
            } else {
                doc.font(fontBold).fontSize(26).fillColor('#FF6B1A').text('RELIV', margin + 14, headerY + 16);
            }
            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text('Your Personalized Health Checkup.', margin + 14, headerY + 68);

            // Header Right
            doc.font(fontBold).fontSize(15).fillColor('#172033').text('PURCHASE RECEIPT', margin, headerY + 14, { width: contentWidth - 14, align: 'right' });
            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Receipt: ${data.receiptId}`, margin, headerY + 34, { width: contentWidth - 14, align: 'right' });
            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Date: ${formatReceiptDate(data.paidAt)}`, margin, headerY + 48, { width: contentWidth - 14, align: 'right' });

            // Paid Badge
            const badgeW = 60, badgeH = 18;
            const badgeX = margin + contentWidth - badgeW - 14;
            const badgeY = headerY + 66;
            doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9).fillAndStroke('#ECFDF3', '#A7F3D0');
            doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text('✓ PAID', badgeX, badgeY + 4, { width: badgeW, align: 'center' });

            // ── 2. Meta Cards (Billed To & Payment Details) ──────────────
            const cardY = 150;
            const cardH = 82;
            const cardGap = 12;
            const cardW = (contentWidth - cardGap) / 2;

            // Left Card: Billed To
            doc.roundedRect(margin, cardY, cardW, cardH, 8).fillAndStroke('#F8F9FA', '#E5E7EB');
            doc.font(fontBold).fontSize(8).fillColor('#667085').text('BILLED TO', margin + 12, cardY + 10);
            
            if (data.customerName) {
                doc.font(fontBold).fontSize(10.5).fillColor('#172033').text(data.customerName, margin + 12, cardY + 24);
                doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(data.recipientEmail, margin + 12, cardY + 40, { width: cardW - 24, lineBreak: false, ellipsis: true });
                doc.font(fontRegular).fontSize(8).fillColor('#9CA3AF').text(`Kiosk: ${data.kioskId}`, margin + 12, cardY + 56);
            } else {
                doc.font(fontBold).fontSize(10.5).fillColor('#172033').text('Valued Customer', margin + 12, cardY + 24);
                doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(data.recipientEmail, margin + 12, cardY + 40, { width: cardW - 24, lineBreak: false, ellipsis: true });
                doc.font(fontRegular).fontSize(8).fillColor('#9CA3AF').text(`Kiosk Session: ${data.sessionId}`, margin + 12, cardY + 56);
            }

            // Right Card: Payment Details
            const rCardX = margin + cardW + cardGap;
            doc.roundedRect(rCardX, cardY, cardW, cardH, 8).fillAndStroke('#F8F9FA', '#E5E7EB');
            doc.font(fontBold).fontSize(8).fillColor('#667085').text('PAYMENT DETAILS', rCardX + 12, cardY + 10);
            doc.font(fontBold).fontSize(9).fillColor('#172033').text(`Payment ID: ${data.paymentId}`, rCardX + 12, cardY + 24, { width: cardW - 24, lineBreak: false, ellipsis: true });
            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text('Method: Razorpay Online (UPI/Card)', rCardX + 12, cardY + 38);
            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Paid At: ${formatReceiptDateTime(data.paidAt)}`, rCardX + 12, cardY + 52);
            doc.font(fontBold).fontSize(8).fillColor('#15803D').text('Status: Captured (Authoritative)', rCardX + 12, cardY + 66);

            // ── 3. Purchase Details Table ────────────────────────────────
            const tableTop = 244;
            doc.font(fontBold).fontSize(11).fillColor('#172033').text('Purchase Details', margin, tableTop);

            const thY = tableTop + 18;
            const thH = 22;
            doc.roundedRect(margin, thY, contentWidth, thH, 4).fillAndStroke('#F1F3F6', '#E2E8F0');
            doc.font(fontBold).fontSize(8).fillColor('#475569');
            doc.text('DESCRIPTION', margin + 10, thY + 6, { width: 235, align: 'left' });
            doc.text('QTY', margin + 250, thY + 6, { width: 50, align: 'center' });
            doc.text('UNIT PRICE', margin + 310, thY + 6, { width: 85, align: 'right' });
            doc.text('AMOUNT', margin + 405, thY + 6, { width: 90, align: 'right' });

            let rowY = thY + thH + 4;
            const rowH = 24;

            if (data.cartItems && data.cartItems.length > 0) {
                data.cartItems.forEach((item, idx) => {
                    if (idx % 2 === 1) {
                        doc.rect(margin, rowY - 2, contentWidth, rowH).fill('#FBFBFC');
                    }
                    doc.font(fontRegular).fontSize(9).fillColor('#1E293B');
                    doc.text(item.name, margin + 10, rowY + 4, { width: 235, lineBreak: false, ellipsis: true });
                    doc.text(String(item.qty), margin + 250, rowY + 4, { width: 50, align: 'center' });
                    doc.font(fontBold).text(`${currencySymbol}${item.unitPrice.toFixed(2)}`, margin + 310, rowY + 4, { width: 85, align: 'right' });
                    doc.text(`${currencySymbol}${item.total.toFixed(2)}`, margin + 405, rowY + 4, { width: 90, align: 'right' });

                    doc.moveTo(margin, rowY + rowH - 2).lineTo(margin + contentWidth, rowY + rowH - 2).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
                    rowY += rowH;
                });
            } else {
                // Authoritative service line without fabricated items
                doc.font(fontRegular).fontSize(9).fillColor('#1E293B');
                doc.text(data.serviceType, margin + 10, rowY + 4, { width: 235, lineBreak: false, ellipsis: true });
                doc.text('1', margin + 250, rowY + 4, { width: 50, align: 'center' });
                doc.font(fontBold).text(`${currencySymbol}${data.amountInRupees.toFixed(2)}`, margin + 310, rowY + 4, { width: 85, align: 'right' });
                doc.text(`${currencySymbol}${data.amountInRupees.toFixed(2)}`, margin + 405, rowY + 4, { width: 90, align: 'right' });

                doc.moveTo(margin, rowY + rowH - 2).lineTo(margin + contentWidth, rowY + rowH - 2).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
                rowY += rowH;
            }

            // ── 4. Summary Card ──────────────────────────────────────────
            const sumW = 220;
            const sumX = margin + contentWidth - sumW;
            const sumY = rowY + 8;

            doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text('Subtotal', sumX, sumY);
            doc.font(fontBold).fontSize(8.5).fillColor('#1E293B').text(`${currencySymbol}${data.amountInRupees.toFixed(2)}`, sumX, sumY, { width: sumW, align: 'right' });

            const totalRowY = sumY + 16;
            doc.roundedRect(sumX, totalRowY, sumW, 28, 6).fill('#172033');
            doc.font(fontBold).fontSize(10).fillColor('#FFFFFF').text('TOTAL PAID', sumX + 12, totalRowY + 8);
            doc.font(fontBold).fontSize(12).fillColor('#FF6B1A').text(`${currencySymbol}${data.amountInRupees.toFixed(2)}`, sumX, totalRowY + 7, { width: sumW - 12, align: 'right' });

            // ── 5. Digital Confirmation ──────────────────────────────────
            const confY = totalRowY + 36;
            doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text('✓ Payment received successfully. This is an authoritative digitally generated receipt.', margin, confY, { width: contentWidth, align: 'center' });

            // ── 6. Sustainability Impact Card ───────────────────────────
            const impactY = confY + 16;
            const impactH = 70;
            doc.roundedRect(margin, impactY, contentWidth, impactH, 8).fillAndStroke('#ECFDF3', '#A7F3D0');
            doc.font(fontBold).fontSize(9.5).fillColor('#15803D').text('🌱 Your digital choice made an impact', margin + 12, impactY + 8);

            const mGap = 8;
            const mW = (contentWidth - 24 - (mGap * 2)) / 3;
            const metrics = [
                { val: '~20 L', label: 'Water Saved' },
                { val: '~18 g', label: 'CO₂ Reduced' },
                { val: '2 Sheets', label: 'Paper Saved' }
            ];
            metrics.forEach((m, i) => {
                const mX = margin + 12 + i * (mW + mGap);
                const mY = impactY + 24;
                doc.roundedRect(mX, mY, mW, 24, 4).fill('#FFFFFF');
                doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text(m.val, mX + 6, mY + 6);
                doc.font(fontRegular).fontSize(7.5).fillColor('#4B5563').text(m.label, mX + 44, mY + 7);
            });

            doc.font(fontRegular).fontSize(7.5).fillColor('#047857').text(
                'Together, Reliv users have saved approximately 3,460 L of water, reduced 3,114 g of CO₂, and avoided 346 sheets of paper.',
                margin + 12, impactY + 53, { width: contentWidth - 24 }
            );

            // ── 7. Footer ───────────────────────────────────────────────
            const footerY = 780;
            doc.moveTo(margin, footerY - 8).lineTo(margin + contentWidth, footerY - 8).strokeColor('#E5E7EB').lineWidth(0.75).stroke();
            doc.font(fontBold).fontSize(8.5).fillColor('#172033').text('Thank you for choosing Reliv. • Your partner in proactive healthcare.', margin, footerY, { width: contentWidth, align: 'center' });
            doc.font(fontRegular).fontSize(8).fillColor('#4B5563').text('Support: relivcustomercare.in@gmail.com   |   Instagram: @reliv_care', margin, footerY + 12, { width: contentWidth, align: 'center' });
            doc.font(fontRegular).fontSize(7.5).fillColor('#9CA3AF').text('No signature required. • Generated securely by Reliv Health Systems', margin, footerY + 24, { width: contentWidth, align: 'center' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

export default {
    formatServiceType,
    formatReceiptDate,
    formatReceiptDateTime,
    setupPdfFonts,
    normalizeCloudReceiptData,
    generateCloudReceiptPdfBuffer
};
