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
 *
 * PAGINATION & LAYOUT RULES:
 * - autoFirstPage: false and margins.bottom: 0 — we manually control page flow
 *   and prevent PDFKit from silently creating trailing pages.
 * - Single-page receipts for standard orders (1-5 items) with zero overflow.
 * - Clickable customer care email & Instagram handle links.
 * - Dynamic authoritative service / medicine names.
 * - Clean all-light aesthetic matching Reliv design standards.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── A4 Geometry Constants ───────────────────────────────────────────────
const PAGE_WIDTH  = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_H    = 32;
const CONTENT_W   = PAGE_WIDTH - (MARGIN_H * 2); // ~531.28 pt
const DOC_MARGINS = { top: 30, bottom: 0, left: MARGIN_H, right: MARGIN_H };

// ── Color Palette (Approved All-Light Theme) ────────────────────────────
const C = {
    navy:        '#172033',
    secondary:   '#667085',
    muted:       '#9CA3AF',
    orange:      '#FF641A',
    paleOrange:  '#FFF4ED',
    warmBg:      '#FFFBF8',
    surface:     '#FCFCFD',
    border:      '#E4E7EC',
    divider:     '#EAECF0',
    green:       '#15803D',
    paleGreen:   '#F5FBF7',
    greenBorder: '#D8EADF',
    white:       '#FFFFFF',
    tableHead:   '#F8FAFC',
    bodyText:    '#1E293B',
};

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
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Format date & time as "23 August 2026, 9:37 AM"
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
 * Format amount in rupees with ₹ or INR prefix
 * @param {number} rupees
 * @param {string} symbol
 * @returns {string}
 */
function fmtAmt(rupees, symbol) {
    return `${symbol}${rupees.toFixed(2)}`;
}

/**
 * Safe string sanitizer
 * @param {*} val
 * @param {string} [fallback='']
 * @returns {string}
 */
function safe(val, fallback = '') {
    if (val === null || val === undefined || val === '') return fallback;
    const s = String(val);
    if (s === 'undefined' || s === 'null' || s === 'NaN' || s === '[object Object]') return fallback;
    return s;
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
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Setup TrueType fonts supporting the Indian Rupee (₹) symbol
 * @param {PDFDocument} doc
 * @returns {{ fontR: string, fontB: string, sym: string }}
 */
export function setupPdfFonts(doc) {
    let hasBold = false;
    let hasRegular = false;

    const fontPath = resolveAssetPath('fonts/DejaVuSans-Bold.ttf');
    if (fontPath) {
        try {
            doc.registerFont('Reliv-Bold', fontPath);
            hasBold = true;
        } catch (e) {
            console.warn('[ReceiptPdfBuilder] Could not register DejaVuSans-Bold:', e.message);
        }
    }

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
            } catch (e) { /* ignore */ }
        }
    }

    return {
        fontR: hasRegular ? 'Reliv-Regular' : (hasBold ? 'Reliv-Bold' : 'Helvetica'),
        fontB: hasBold   ? 'Reliv-Bold'    : 'Helvetica-Bold',
        sym:   hasBold   ? '₹' : 'INR '
    };
}

/**
 * Build authoritative receipt dataset strictly from Cloud Payment V2 order record
 * @param {Object} order - Authoritative payment_v2_orders row
 * @param {string} recipientEmail - Normalized recipient email
 * @returns {Object}
 */
export function normalizeCloudReceiptData(order, recipientEmail) {
    if (!order) throw new Error('Authoritative order record is required');

    const rawAmount = Number(order.amount) || 0;
    const amountInRupees = rawAmount / 100;
    const paidTimestamp = order.verified_at || order.created_at || Date.now();
    const serviceLabel = formatServiceType(order.service_type);
    const customerName = order.customer_name || order.customerName || null;

    let cartItems = null;
    if (order.cart) {
        try {
            const parsed = typeof order.cart === 'string' ? JSON.parse(order.cart) : order.cart;
            if (Array.isArray(parsed) && parsed.length > 0) {
                cartItems = parsed.map(item => ({
                    name: safe(item.name || item.item_name || item.medicine_name || item.kit_id, 'Medicine Item'),
                    description: safe(item.description || item.desc, ''),
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
        receiptId: safe(order.request_id || order.order_id, 'RLV-RECEIPT'),
        requestId: safe(order.request_id, 'N/A'),
        orderId: safe(order.order_id, 'N/A'),
        paymentId: safe(order.razorpay_payment_id, 'N/A'),
        transactionId: safe(order.transaction_id, 'N/A'),
        sessionId: safe(order.session_id, 'N/A'),
        kioskId: safe(order.kiosk_id, 'N/A'),
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

/** Draw a rounded-rect card with fill and border */
function drawCard(doc, x, y, w, h, fill, stroke = C.border, r = 8) {
    doc.roundedRect(x, y, w, h, r).fillAndStroke(fill, stroke);
}

/**
 * Get the number of pages buffered so far
 * @param {PDFDocument} doc
 * @returns {number}
 */
export function getPageCount(doc) {
    return doc.bufferedPageRange().count;
}

/**
 * Generate an A4 Reliv Payment Receipt PDF in memory.
 * Standard receipts generate exactly 1 page.
 *
 * @param {Object} order - Authoritative order from database
 * @param {string} recipientEmail - Recipient email
 * @returns {Promise<Buffer>}
 */
export async function generateCloudReceiptPdfBuffer(order, recipientEmail) {
    return new Promise((resolve, reject) => {
        try {
            const data = normalizeCloudReceiptData(order, recipientEmail);

            const doc = new PDFDocument({
                size: 'A4',
                margins: DOC_MARGINS,
                bufferPages: true,
                autoFirstPage: false
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));

            const { fontR, fontB, sym } = setupPdfFonts(doc);

            // Add Page 1 with zero bottom margin to prevent accidental line-wrap page additions
            doc.addPage({ size: 'A4', margins: DOC_MARGINS });

            let y = 28;

            // ============================================================
            //  1. HEADER SECTION (All-Light, Clean Open Layout)
            // ============================================================
            const logoPath = resolveAssetPath('assets/reliv.png') || resolveAssetPath('reliv.png');
            if (logoPath) {
                try {
                    // Logo scaled cleanly (height: 36 pt, preserved aspect ratio)
                    doc.image(logoPath, MARGIN_H, y, { height: 36 });
                } catch (e) {
                    doc.font(fontB).fontSize(22).fillColor(C.orange).text('RELIV', MARGIN_H, y + 2);
                }
            } else {
                doc.font(fontB).fontSize(22).fillColor(C.orange).text('RELIV', MARGIN_H, y + 2);
            }

            // Tagline below logo
            doc.font(fontR).fontSize(9).fillColor(C.navy)
               .text('Your Personalized Health Checkup.', MARGIN_H, y + 42);

            // Right side: Header details
            doc.font(fontB).fontSize(16).fillColor(C.navy)
               .text('PURCHASE RECEIPT', MARGIN_H, y, { width: CONTENT_W, align: 'right' });

            doc.font(fontR).fontSize(8.5).fillColor(C.secondary)
               .text(`Receipt No. ${data.receiptId}`, MARGIN_H, y + 22, { width: CONTENT_W, align: 'right' });

            doc.font(fontR).fontSize(8.5).fillColor(C.secondary)
               .text(formatReceiptDate(data.paidAt), MARGIN_H, y + 34, { width: CONTENT_W, align: 'right' });

            // Compact Green PAID pill below date
            const badgeW = 58, badgeH = 18;
            const badgeX = MARGIN_H + CONTENT_W - badgeW;
            const badgeY = y + 48;
            doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9)
               .fillAndStroke(C.paleGreen, C.greenBorder);
            doc.font(fontB).fontSize(8).fillColor(C.green)
               .text('\u2713 PAID', badgeX, badgeY + 4, { width: badgeW, align: 'center' });

            y += 74;

            // ============================================================
            //  2. BILLED TO & PAYMENT DETAILS (Twin Cards)
            // ============================================================
            const cardGap = 12;
            const cardW = (CONTENT_W - cardGap) / 2;
            const cardH = 78;
            const cardPad = 12;

            // Left Card: Billed To
            drawCard(doc, MARGIN_H, y, cardW, cardH, C.surface, C.border, 8);
            doc.font(fontB).fontSize(7.5).fillColor(C.secondary)
               .text('BILLED TO', MARGIN_H + cardPad, y + 9);

            const custName = data.customerName || 'Valued Customer';
            doc.font(fontB).fontSize(11).fillColor(C.navy)
               .text(custName, MARGIN_H + cardPad, y + 22, { width: cardW - cardPad * 2 });
            doc.font(fontR).fontSize(8).fillColor(C.secondary)
               .text(data.recipientEmail, MARGIN_H + cardPad, y + 37, { width: cardW - cardPad * 2, lineBreak: false, ellipsis: true });

            doc.moveTo(MARGIN_H + cardPad, y + 51).lineTo(MARGIN_H + cardW - cardPad, y + 51)
               .strokeColor(C.divider).lineWidth(0.5).stroke();

            doc.font(fontR).fontSize(7.5).fillColor(C.muted)
               .text(`Session: ${data.sessionId}`, MARGIN_H + cardPad, y + 57, { width: cardW - cardPad * 2, lineBreak: false, ellipsis: true });

            // Right Card: Payment Details
            const rX = MARGIN_H + cardW + cardGap;
            drawCard(doc, rX, y, cardW, cardH, C.surface, C.border, 8);
            doc.font(fontB).fontSize(7.5).fillColor(C.secondary)
               .text('PAYMENT DETAILS', rX + cardPad, y + 9);

            doc.font(fontB).fontSize(8).fillColor(C.navy)
               .text('Payment ID: ', rX + cardPad, y + 22, { continued: true });
            doc.font(fontR).fillColor(C.navy)
               .text(data.paymentId, { width: cardW - cardPad * 2 - 60, lineBreak: false, ellipsis: true });

            doc.font(fontB).fontSize(8).fillColor(C.navy)
               .text('Method: ', rX + cardPad, y + 34, { continued: true });
            doc.font(fontR).fillColor(C.secondary)
               .text('Razorpay Online (UPI/Card)');

            doc.font(fontB).fontSize(8).fillColor(C.navy)
               .text('Paid at: ', rX + cardPad, y + 46, { continued: true });
            doc.font(fontR).fillColor(C.secondary)
               .text(formatReceiptDateTime(data.paidAt));

            doc.font(fontB).fontSize(7.5).fillColor(C.green)
               .text('\u2022 Payment Successful \u2022 Server Verified', rX + cardPad, y + 60);

            y += cardH + 14;

            // ============================================================
            //  3. PURCHASE SUMMARY TABLE
            // ============================================================
            doc.font(fontB).fontSize(9.5).fillColor(C.navy).text('PURCHASE SUMMARY', MARGIN_H, y);
            y += 12;

            const colItem = MARGIN_H + 10;
            const colQty  = MARGIN_H + 280;
            const colUnit = MARGIN_H + 340;
            const colAmt  = MARGIN_H + CONTENT_W - 10;
            const thH = 22;

            // Table Header
            doc.roundedRect(MARGIN_H, y, CONTENT_W, thH, 4).fillAndStroke(C.tableHead, C.border);
            doc.font(fontB).fontSize(7.5).fillColor(C.secondary);
            doc.text('ITEM',       colItem, y + 6, { width: 240, align: 'left' });
            doc.text('QTY',        colQty,  y + 6, { width: 50,  align: 'center' });
            doc.text('UNIT PRICE', colUnit, y + 6, { width: 80,  align: 'right' });
            doc.text('AMOUNT',     colAmt - 80, y + 6, { width: 80,  align: 'right' });

            y += thH;
            const rowH = 24;

            const items = data.cartItems && data.cartItems.length > 0
                ? data.cartItems
                : [{ name: data.serviceType, description: '', qty: 1, unitPrice: data.amountInRupees, total: data.amountInRupees }];

            // Threshold for creating another page for extreme multi-item carts
            const MAX_Y_BEFORE_PAGINATE = 560;

            items.forEach((item, idx) => {
                if (y + rowH > MAX_Y_BEFORE_PAGINATE && idx > 0) {
                    doc.addPage({ size: 'A4', margins: DOC_MARGINS });
                    y = 30;
                    // Repeat table header on page 2
                    doc.roundedRect(MARGIN_H, y, CONTENT_W, thH, 4).fillAndStroke(C.tableHead, C.border);
                    doc.font(fontB).fontSize(7.5).fillColor(C.secondary);
                    doc.text('ITEM',       colItem, y + 6, { width: 240, align: 'left' });
                    doc.text('QTY',        colQty,  y + 6, { width: 50,  align: 'center' });
                    doc.text('UNIT PRICE', colUnit, y + 6, { width: 80,  align: 'right' });
                    doc.text('AMOUNT',     colAmt - 80, y + 6, { width: 80,  align: 'right' });
                    y += thH;
                }

                if (idx % 2 === 1) {
                    doc.rect(MARGIN_H, y, CONTENT_W, rowH).fill('#FAFBFC');
                }

                doc.font(fontR).fontSize(8.5).fillColor(C.bodyText);
                doc.text(item.name, colItem, y + 5, { width: 260, lineBreak: false, ellipsis: true });
                doc.font(fontR).fontSize(8.5).fillColor(C.bodyText)
                   .text(String(item.qty), colQty, y + 5, { width: 50, align: 'center' });
                doc.font(fontR).fontSize(8.5).fillColor(C.bodyText)
                   .text(fmtAmt(item.unitPrice, sym), colUnit, y + 5, { width: 80, align: 'right' });
                doc.font(fontB).fontSize(8.5).fillColor(C.bodyText)
                   .text(fmtAmt(item.total, sym), colAmt - 80, y + 5, { width: 80, align: 'right' });

                doc.moveTo(MARGIN_H, y + rowH - 1).lineTo(MARGIN_H + CONTENT_W, y + rowH - 1)
                   .strokeColor(C.divider).lineWidth(0.5).stroke();

                y += rowH;
            });

            // ── Payment Summary Strip ──────────────────────────────────
            const sumW = 190;
            const sumX = MARGIN_H + CONTENT_W - sumW;
            y += 4;

            doc.font(fontR).fontSize(8).fillColor(C.secondary)
               .text('Subtotal', sumX, y);
            doc.font(fontB).fontSize(8).fillColor(C.navy)
               .text(fmtAmt(data.amountInRupees, sym), sumX, y, { width: sumW, align: 'right' });
            y += 12;

            // Total Paid Box (Pale Orange with thin accent line)
            const totalH = 26;
            doc.roundedRect(sumX, y, sumW, totalH, 5).fill(C.paleOrange);
            doc.moveTo(sumX, y + 0.5).lineTo(sumX + sumW, y + 0.5)
               .strokeColor(C.orange).lineWidth(1).stroke();
            doc.font(fontB).fontSize(8.5).fillColor(C.navy)
               .text('TOTAL PAID', sumX + 8, y + 8);
            doc.font(fontB).fontSize(12).fillColor(C.orange)
               .text(fmtAmt(data.amountInRupees, sym), sumX, y + 6, { width: sumW - 8, align: 'right' });
            y += totalH + 10;

            // ============================================================
            //  4. PAYMENT CONFIRMATION CARD
            // ============================================================
            const confH = 36;
            drawCard(doc, MARGIN_H, y, CONTENT_W, confH, C.paleGreen, C.greenBorder, 6);
            doc.font(fontB).fontSize(8.5).fillColor(C.green)
               .text('\u2713 Payment received successfully', MARGIN_H + 12, y + 7);
            doc.font(fontR).fontSize(7.5).fillColor(C.secondary)
               .text('Your payment was securely verified and this receipt was generated digitally.', MARGIN_H + 12, y + 20, { width: CONTENT_W - 24 });
            y += confH + 10;

            // ============================================================
            //  5. YOUR RELIV IMPACT (Understated Pale-Green Theme)
            // ============================================================
            const impactH = 72;
            drawCard(doc, MARGIN_H, y, CONTENT_W, impactH, C.paleGreen, C.greenBorder, 6);

            doc.font(fontB).fontSize(8.5).fillColor(C.green)
               .text('YOUR RELIV IMPACT', MARGIN_H + 12, y + 7);
            doc.font(fontR).fontSize(7.5).fillColor(C.secondary)
               .text('Small digital choices create meaningful change.', MARGIN_H + 12, y + 18);

            // Divider
            doc.moveTo(MARGIN_H + 12, y + 28).lineTo(MARGIN_H + CONTENT_W - 12, y + 28)
               .strokeColor(C.greenBorder).lineWidth(0.5).stroke();

            // 3 Clean Metric Columns
            const metricW = (CONTENT_W - 24) / 3;
            const metrics = [
                { val: '20 L',  label: 'Water saved' },
                { val: '18 g',  label: 'CO\u2082 reduced' },
                { val: '2',     label: 'Paper sheets saved' }
            ];
            metrics.forEach((m, i) => {
                const mx = MARGIN_H + 12 + (i * metricW);
                const my = y + 32;
                doc.font(fontB).fontSize(12).fillColor(C.green).text(m.val, mx, my, { width: metricW, align: 'center' });
                doc.font(fontR).fontSize(7).fillColor(C.navy).text(m.label, mx, my + 15, { width: metricW, align: 'center' });
                if (i < 2) {
                    const dvx = mx + metricW - 1;
                    doc.moveTo(dvx, y + 31).lineTo(dvx, y + 62)
                       .strokeColor(C.greenBorder).lineWidth(0.5).stroke();
                }
            });

            doc.font(fontR).fontSize(6.5).fillColor(C.green)
               .text('Together, Reliv users have saved ~3,460 L water, reduced ~3,114 g CO\u2082, and avoided ~346 sheets of paper.', MARGIN_H + 12, y + 59, { width: CONTENT_W - 24, align: 'center' });

            y += impactH + 10;

            // ============================================================
            //  6. HELP AND CONTACT SECTION (Clickable Links)
            // ============================================================
            const helpH = 46;
            drawCard(doc, MARGIN_H, y, CONTENT_W, helpH, C.white, C.border, 6);

            const helpHalf = (CONTENT_W - 24) / 2;
            const helpLx = MARGIN_H + 12;
            const helpRx = MARGIN_H + 12 + helpHalf + 12;

            doc.font(fontB).fontSize(7.5).fillColor(C.navy)
               .text('NEED HELP?', helpLx, y + 7);
            doc.font(fontR).fontSize(7).fillColor(C.secondary)
               .text("We're here to help with your payment, receipt, or Reliv experience.", helpLx, y + 18, { width: helpHalf - 12 });

            // Vertical divider
            const vdx = MARGIN_H + 12 + helpHalf;
            doc.moveTo(vdx, y + 6).lineTo(vdx, y + helpH - 6)
               .strokeColor(C.divider).lineWidth(0.5).stroke();

            // Right side: Customer Care & Instagram
            doc.font(fontB).fontSize(7).fillColor(C.secondary).text('Customer Care: ', helpRx, y + 7, { continued: true });
            doc.font(fontR).fillColor(C.navy).text('relivcustomercare.in@gmail.com', { link: 'mailto:relivcustomercare.in@gmail.com', underline: false });

            doc.font(fontB).fontSize(7).fillColor(C.secondary).text('Instagram: ', helpRx, y + 23, { continued: true });
            doc.font(fontR).fillColor(C.navy).text('@reliv_care', { link: 'https://instagram.com/reliv_care', underline: false });

            y += helpH + 12;

            // ============================================================
            //  7. LIGHT FOOTER (Always within bottom safe zone)
            // ============================================================
            const footerY = Math.max(y, 775);

            doc.moveTo(MARGIN_H, footerY).lineTo(MARGIN_H + CONTENT_W, footerY)
               .strokeColor(C.border).lineWidth(0.5).stroke();

            doc.font(fontB).fontSize(7.5).fillColor(C.navy)
               .text('Thank you for choosing Reliv.', MARGIN_H, footerY + 5, { width: CONTENT_W, align: 'center' });
            doc.font(fontR).fontSize(7).fillColor(C.secondary)
               .text('Your partner in proactive healthcare.', MARGIN_H, footerY + 15, { width: CONTENT_W, align: 'center' });
            doc.font(fontR).fontSize(6.5).fillColor(C.muted)
               .text('Digitally generated receipt \u2022 No signature required', MARGIN_H, footerY + 25, { width: CONTENT_W, align: 'center' });

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
    generateCloudReceiptPdfBuffer,
    getPageCount
};
