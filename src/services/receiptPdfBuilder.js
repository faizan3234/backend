import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

export function setupPdfFonts(doc) {
    let hasBold = false;
    let hasRegular = false;

    // Check project fonts
    const boldFontPath = path.join(process.cwd(), 'fonts', 'DejaVuSans-Bold.ttf');
    if (fs.existsSync(boldFontPath)) {
        try {
            doc.registerFont('Reliv-Bold', boldFontPath);
            hasBold = true;
        } catch (e) {
            console.warn('[PDFGenerator] Could not register DejaVuSans-Bold:', e.message);
        }
    }

    // Check Windows system fonts if available
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

export function formatReceiptDate(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
}

export function formatReceiptDateTime(dateInput) {
    const d = dateInput ? new Date(dateInput) : new Date();
    const datePart = formatReceiptDate(d);
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${datePart}, ${hours}:${minutes} ${ampm}`;
}

export function normalizeReceiptData(customerOrData, transactionOrEco, ecoStats) {
    let customer = {};
    let transaction = {};
    let cart = [];
    let needsReport = false;
    let totalPrice = 0;
    let receiptNumber = '';
    let issueDate = new Date();
    let paymentMethod = 'Razorpay Online (UPI/Card)';
    let paymentId = '';
    let status = 'PAID';
    let stats = ecoStats;

    if (customerOrData && (customerOrData.patient || customerOrData.cart || customerOrData.totalPrice !== undefined)) {
        // Called like generateReceiptPdf(data, ecoStats)
        customer = customerOrData.patient || {};
        cart = customerOrData.cart || [];
        needsReport = Boolean(customerOrData.needsReport);
        totalPrice = Number(customerOrData.totalPrice) || 0;
        receiptNumber = customerOrData.transactionId || customerOrData.receiptNumber || customerOrData.orderId || '';
        paymentId = customerOrData.paymentId || customerOrData.providerPaymentId || '';
        if (customerOrData.date) issueDate = new Date(customerOrData.date);
        if (customerOrData.status) status = customerOrData.status;
        stats = transactionOrEco || ecoStats;
    } else {
        // Called like _createReceiptPDF(customerData, transaction)
        customer = customerOrData || {};
        transaction = transactionOrEco || {};
        const rawCart = transaction.cart;
        if (Array.isArray(rawCart)) {
            cart = rawCart;
        } else if (typeof rawCart === 'string') {
            try { cart = JSON.parse(rawCart); } catch { cart = []; }
        }
        
        needsReport = transaction.type === 'HEALTH_CHECKUP' || transaction.type === 'CHECKUP' || transaction.needsReport;
        
        const rawAmt = Number(transaction.amount) || 0;
        totalPrice = rawAmt > 5000 ? (rawAmt / 100) : rawAmt;
        
        receiptNumber = transaction.transaction_id || transaction.receipt_id || '';
        paymentId = transaction.provider_payment_id || transaction.payment_id || transaction.razorpay_payment_id || '';
        if (transaction.created_at) issueDate = new Date(transaction.created_at);
        if (transaction.status) status = transaction.status;
    }

    if (!receiptNumber) {
        const dStr = issueDate.toISOString().slice(0, 10).replace(/-/g, '');
        const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
        receiptNumber = `RLV-${dStr}-${rnd}`;
    }

    // Build items list
    const items = [];
    if (needsReport) {
        const reportPrice = Number(process.env.REPORT_PRICE || 17.00);
        items.push({
            name: 'Health Checkup Report',
            description: 'Vital signs & body composition analysis',
            qty: 1,
            unitPrice: reportPrice,
            amount: reportPrice
        });
    }

    if (Array.isArray(cart)) {
        cart.forEach(item => {
            const qty = Number(item.cartQuantity || item.quantity || 1);
            const price = Number(item.price || item.unit_price || item.base_price || 0);
            const name = item.name || item.item_name || item.medicine_name || item.kit_id || 'Medicine Item';
            const desc = item.description || item.dosage || '';
            const total = Number(item.total || (price * qty));
            items.push({
                name,
                description: desc,
                qty,
                unitPrice: price,
                amount: total
            });
        });
    }

    if (items.length === 0) {
        items.push({
            name: 'Reliv Health Checkup Service',
            description: 'Automated Kiosk Health Assessment',
            qty: 1,
            unitPrice: totalPrice || 17.00,
            amount: totalPrice || 17.00
        });
    }

    let calculatedSubtotal = items.reduce((acc, it) => acc + (it.amount || (it.unitPrice * it.qty)), 0);
    if (totalPrice <= 0) {
        totalPrice = calculatedSubtotal;
    }

    return {
        customer: {
            name: customer.name || customer.patientName || 'Walk-in Customer',
            email: customer.email || '',
            phone: customer.phone || customer.mobile || ''
        },
        payment: {
            receiptNumber,
            transactionId: receiptNumber,
            paymentId,
            method: paymentMethod,
            date: issueDate,
            status: String(status).toUpperCase() === 'PAID' || String(status).toUpperCase() === 'VERIFIED' || String(status).toUpperCase() === 'CAPTURED' ? 'PAID' : 'PAID'
        },
        items,
        subtotal: calculatedSubtotal,
        totalPaid: totalPrice,
        ecoStats: stats
    };
}

export function drawReceiptDocument(doc, normalizedData) {
    const { fontRegular, fontBold, currencySymbol } = setupPdfFonts(doc);
    const { customer, payment, items, subtotal, totalPaid, ecoStats } = normalizedData;

    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const margin = 44;
    const contentWidth = pageWidth - (margin * 2);

    function drawHeader() {
        const headerY = 40;
        const headerH = 100;
        doc.roundedRect(margin, headerY, contentWidth, headerH, 10).fillAndStroke('#FFF5EF', '#FFE2D1');

        // Logo
        const logoPath = path.join(process.cwd(), 'reliv.png');
        if (fs.existsSync(logoPath)) {
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
        doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Receipt: ${payment.receiptNumber}`, margin, headerY + 34, { width: contentWidth - 14, align: 'right' });
        doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Date: ${formatReceiptDate(payment.date)}`, margin, headerY + 48, { width: contentWidth - 14, align: 'right' });

        // Paid Badge
        const badgeW = 60, badgeH = 18;
        const badgeX = margin + contentWidth - badgeW - 14;
        const badgeY = headerY + 66;
        doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 9).fillAndStroke('#ECFDF3', '#A7F3D0');
        doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text('✓ PAID', badgeX, badgeY + 4, { width: badgeW, align: 'center' });
    }

    function drawFooter(pageNumber, totalPages) {
        const footerY = 780;
        doc.moveTo(margin, footerY - 8).lineTo(margin + contentWidth, footerY - 8).strokeColor('#E5E7EB').lineWidth(0.75).stroke();
        doc.font(fontBold).fontSize(8.5).fillColor('#172033').text('Thank you for choosing Reliv. • Your partner in proactive healthcare.', margin, footerY, { width: contentWidth, align: 'center' });
        doc.font(fontRegular).fontSize(8).fillColor('#4B5563').text('Support: relivcustomercare.in@gmail.com   |   Instagram: @reliv_care', margin, footerY + 12, { width: contentWidth, align: 'center' });
        
        const pageText = totalPages > 1 ? `Page ${pageNumber} of ${totalPages} • ` : '';
        doc.font(fontRegular).fontSize(7.5).fillColor('#9CA3AF').text(`${pageText}No signature required. • Generated securely by Reliv Health Systems`, margin, footerY + 24, { width: contentWidth, align: 'center' });
    }

    drawHeader();

    // 2. Meta Cards
    const cardY = 150;
    const cardH = 82;
    const cardGap = 12;
    const cardW = (contentWidth - cardGap) / 2;

    // Left Card
    doc.roundedRect(margin, cardY, cardW, cardH, 8).fillAndStroke('#F8F9FA', '#E5E7EB');
    doc.font(fontBold).fontSize(8).fillColor('#667085').text('BILLED TO', margin + 12, cardY + 10);
    doc.font(fontBold).fontSize(10.5).fillColor('#172033').text(customer.name, margin + 12, cardY + 24);
    if (customer.email) {
        doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(customer.email, margin + 12, cardY + 40, { width: cardW - 24, lineBreak: false, ellipsis: true });
    }
    if (customer.phone) {
        doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(customer.phone, margin + 12, cardY + 54);
    }

    // Right Card
    const rCardX = margin + cardW + cardGap;
    doc.roundedRect(rCardX, cardY, cardW, cardH, 8).fillAndStroke('#F8F9FA', '#E5E7EB');
    doc.font(fontBold).fontSize(8).fillColor('#667085').text('PAYMENT DETAILS', rCardX + 12, cardY + 10);
    doc.font(fontBold).fontSize(9).fillColor('#172033').text(`ID: ${payment.paymentId || payment.transactionId}`, rCardX + 12, cardY + 24, { width: cardW - 24, lineBreak: false, ellipsis: true });
    doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Method: ${payment.method}`, rCardX + 12, cardY + 38);
    doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text(`Paid At: ${formatReceiptDateTime(payment.date)}`, rCardX + 12, cardY + 52);
    doc.font(fontBold).fontSize(8).fillColor('#15803D').text('Status: Captured (Authoritative)', rCardX + 12, cardY + 66);

    // 3. Purchase Table
    let tableTop = 244;
    doc.font(fontBold).fontSize(11).fillColor('#172033').text('Purchase Details', margin, tableTop);

    function drawTableHeader(yPos) {
        const thH = 22;
        doc.roundedRect(margin, yPos, contentWidth, thH, 4).fillAndStroke('#F1F3F6', '#E2E8F0');
        doc.font(fontBold).fontSize(8).fillColor('#475569');
        doc.text('DESCRIPTION', margin + 10, yPos + 6, { width: 235, align: 'left' });
        doc.text('QTY', margin + 250, yPos + 6, { width: 50, align: 'center' });
        doc.text('UNIT PRICE', margin + 310, yPos + 6, { width: 85, align: 'right' });
        doc.text('AMOUNT', margin + 405, yPos + 6, { width: 90, align: 'right' });
        return yPos + thH + 4;
    }

    let rowY = drawTableHeader(tableTop + 18);
    const rowH = 24;

    items.forEach((it, idx) => {
        // Page break check
        if (rowY + rowH > 590) {
            doc.addPage();
            drawHeader();
            rowY = drawTableHeader(150);
        }

        const isAlt = idx % 2 === 1;
        if (isAlt) {
            doc.rect(margin, rowY - 2, contentWidth, rowH).fill('#FBFBFC');
        }
        doc.font(fontRegular).fontSize(9).fillColor('#1E293B');
        doc.text(it.name, margin + 10, rowY + 4, { width: 235, lineBreak: false, ellipsis: true });
        doc.text(String(it.qty), margin + 250, rowY + 4, { width: 50, align: 'center' });
        doc.font(fontBold).text(`${currencySymbol}${it.unitPrice.toFixed(2)}`, margin + 310, rowY + 4, { width: 85, align: 'right' });
        doc.text(`${currencySymbol}${it.amount.toFixed(2)}`, margin + 405, rowY + 4, { width: 90, align: 'right' });

        // Row Divider
        doc.moveTo(margin, rowY + rowH - 2).lineTo(margin + contentWidth, rowY + rowH - 2).strokeColor('#F1F5F9').lineWidth(0.5).stroke();
        rowY += rowH;
    });

    // 4. Summary Card
    const sumW = 220;
    const sumX = margin + contentWidth - sumW;
    const sumY = rowY + 8;

    doc.font(fontRegular).fontSize(8.5).fillColor('#667085').text('Subtotal', sumX, sumY);
    doc.font(fontBold).fontSize(8.5).fillColor('#1E293B').text(`${currencySymbol}${subtotal.toFixed(2)}`, sumX, sumY, { width: sumW, align: 'right' });

    const totalRowY = sumY + 16;
    doc.roundedRect(sumX, totalRowY, sumW, 28, 6).fill('#172033');
    doc.font(fontBold).fontSize(10).fillColor('#FFFFFF').text('TOTAL PAID', sumX + 12, totalRowY + 8);
    doc.font(fontBold).fontSize(12).fillColor('#FF6B1A').text(`${currencySymbol}${totalPaid.toFixed(2)}`, sumX, totalRowY + 7, { width: sumW - 12, align: 'right' });

    // 5. Digital Confirmation
    const confY = totalRowY + 36;
    doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text('✓ Payment received successfully. This is an authoritative digitally generated receipt.', margin, confY, { width: contentWidth, align: 'center' });

    // 6. Sustainability Impact Card
    const impactY = confY + 16;
    const impactH = 70;
    doc.roundedRect(margin, impactY, contentWidth, impactH, 8).fillAndStroke('#ECFDF3', '#A7F3D0');
    doc.font(fontBold).fontSize(9.5).fillColor('#15803D').text('🌱 Your digital choice made an impact', margin + 12, impactY + 8);

    // 3 metric boxes
    const mGap = 8;
    const mW = (contentWidth - 24 - (mGap * 2)) / 3;
    const waterVal = ecoStats?.individual?.water || 20;
    const co2Val = ecoStats?.individual?.co2 || 18;
    const paperVal = ecoStats?.individual?.paper || 2;

    const totalWater = (ecoStats?.total?.water || 3460).toLocaleString();
    const totalCo2 = (ecoStats?.total?.co2 || 3114).toLocaleString();
    const totalPaper = (ecoStats?.total?.paper || 346).toLocaleString();

    const metrics = [
        { val: `~${waterVal} L`, label: 'Water Saved' },
        { val: `~${co2Val} g`, label: 'CO₂ Reduced' },
        { val: `${paperVal} Sheets`, label: 'Paper Saved' }
    ];
    metrics.forEach((m, i) => {
        const mX = margin + 12 + i * (mW + mGap);
        const mY = impactY + 24;
        doc.roundedRect(mX, mY, mW, 24, 4).fill('#FFFFFF');
        doc.font(fontBold).fontSize(8.5).fillColor('#15803D').text(m.val, mX + 6, mY + 6);
        doc.font(fontRegular).fontSize(7.5).fillColor('#4B5563').text(m.label, mX + 44, mY + 7);
    });

    doc.font(fontRegular).fontSize(7.5).fillColor('#047857').text(
        `Together, Reliv users have saved approximately ${totalWater} L of water, ${totalCo2} g of CO₂, and avoided ${totalPaper} sheets of paper.`,
        margin + 12, impactY + 53, { width: contentWidth - 24 }
    );

    // Final footers on all pages
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        drawFooter(i + 1, range.count);
    }
}
