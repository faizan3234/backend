/**
 * PDF Generator Service
 * 
 * Generates health reports and receipts as PDFs, saves them locally.
 * Email delivery is handled separately by the email queue worker.
 * 
 * OFFLINE-FIRST DESIGN:
 * - PDFs generated and saved locally first
 * - Email is queued separately (never blocks generation)
 * - Customer can download PDF immediately from kiosk
 * - Email sends when internet available
 */

import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeReceiptData, drawReceiptDocument } from './receiptPdfBuilder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PDFGenerator {
    constructor(db) {
        this.db = db;
        this.reportsDir = path.join(process.cwd(), 'reports');
        this.receiptsDir = path.join(process.cwd(), 'receipts');
        
        // Ensure directories exist
        if (!fs.existsSync(this.reportsDir)) {
            fs.mkdirSync(this.reportsDir, { recursive: true });
        }
        if (!fs.existsSync(this.receiptsDir)) {
            fs.mkdirSync(this.receiptsDir, { recursive: true });
        }
    }

    /**
     * Generate health report PDF
     * Returns: { reportId, pdfPath, pdfBuffer }
     */
    async generateHealthReport(sessionId, customerData, healthData) {
        const reportId = `RPT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        const filename = `${reportId}.pdf`;
        const pdfPath = path.join(this.reportsDir, filename);

        console.log(`[PDFGenerator] Generating health report: ${reportId} for session ${sessionId}`);

        const buffer = await this._createHealthReportPDF(customerData, healthData);
        
        // Save to file
        fs.writeFileSync(pdfPath, buffer);

        // Save to database
        const stmt = this.db.prepare(`
            INSERT INTO reports (
                report_id, session_id, customer_data, measurements, pdf_path, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);

        stmt.run(
            reportId,
            sessionId,
            JSON.stringify(customerData || {}),
            JSON.stringify(healthData || {}),
            pdfPath,
            'GENERATED'
        );

        console.log(`[PDFGenerator] ✅ Health report saved: ${pdfPath}`);

        return { reportId, pdfPath, pdfBuffer: buffer };
    }

    /**
     * Generate receipt PDF
     * Returns: { receiptId, pdfPath, pdfBuffer }
     */
    async generateReceipt(sessionId, customerData, transaction, ecoStats = null) {
        const receiptId = `RCP-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        const filename = `${receiptId}.pdf`;
        const pdfPath = path.join(this.receiptsDir, filename);

        console.log(`[PDFGenerator] Generating receipt: ${receiptId} for session ${sessionId}`);

        const buffer = await this._createReceiptPDF(customerData, transaction, ecoStats);
        
        // Save to file
        fs.writeFileSync(pdfPath, buffer);

        // Save to database
        const stmt = this.db.prepare(`
            INSERT INTO receipts (
                receipt_id, session_id, transaction_id, pdf_path, status, created_at
            ) VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);

        const txId = transaction?.transaction_id || transaction?.receipt_id || receiptId;
        stmt.run(receiptId, sessionId, txId, pdfPath, 'GENERATED');

        console.log(`[PDFGenerator] ✅ Receipt saved: ${pdfPath}`);

        return { receiptId, pdfPath, pdfBuffer: buffer };
    }

    /**
     * Get report by session
     */
    getReportBySession(sessionId) {
        const stmt = this.db.prepare(`
            SELECT * FROM reports 
            WHERE session_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        return stmt.get(sessionId);
    }

    /**
     * Get receipt by session
     */
    getReceiptBySession(sessionId) {
        const stmt = this.db.prepare(`
            SELECT * FROM receipts 
            WHERE session_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        return stmt.get(sessionId);
    }

    /**
     * Create health report PDF (simplified version)
     * @private
     */
    async _createHealthReportPDF(customerData, healthData) {
        return new Promise((resolve, reject) => {
            const doc = new PDFDocument({ size: 'A4', margin: 50 });
            const chunks = [];

            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Header
            doc.fontSize(24).fillColor('#F97316').text('RELIV HEALTH REPORT', { align: 'center' });
            doc.moveDown(0.5);
            doc.fontSize(10).fillColor('#666').text(new Date().toLocaleDateString(), { align: 'center' });
            doc.moveDown(2);

            // Customer Info
            doc.fontSize(14).fillColor('#111').text('Patient Information', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(11).fillColor('#333');
            doc.text(`Name: ${customerData?.name || 'N/A'}`);
            doc.text(`Age: ${customerData?.age || 'N/A'} years`);
            doc.text(`Gender: ${customerData?.gender || 'N/A'}`);
            if (customerData?.phone) doc.text(`Phone: ${customerData.phone}`);
            doc.moveDown(2);

            // Vitals
            doc.fontSize(14).fillColor('#111').text('Vital Signs', { underline: true });
            doc.moveDown(0.5);
            doc.fontSize(11).fillColor('#333');

            const vitals = healthData?.vitals || {};
            if (vitals.systolic && vitals.diastolic) {
                doc.text(`Blood Pressure: ${vitals.systolic}/${vitals.diastolic} mmHg`);
            }
            if (vitals.bpm) {
                doc.text(`Heart Rate: ${vitals.bpm} BPM`);
            }
            if (vitals.oxygen) {
                doc.text(`SpO2: ${vitals.oxygen}%`);
            }
            if (vitals.temperature) {
                doc.text(`Temperature: ${vitals.temperature}°F`);
            }
            if (healthData?.height) {
                doc.text(`Height: ${healthData.height} cm`);
            }
            if (healthData?.weight) {
                doc.text(`Weight: ${healthData.weight} kg`);
            }
            
            doc.moveDown(2);

            // Body Composition (if available)
            if (healthData?.bodyFat || healthData?.bmi) {
                doc.fontSize(14).fillColor('#111').text('Body Composition', { underline: true });
                doc.moveDown(0.5);
                doc.fontSize(11).fillColor('#333');
                if (healthData.bmi) {
                    doc.text(`BMI: ${healthData.bmi}`);
                }
                if (healthData.bodyFat) {
                    doc.text(`Body Fat: ${healthData.bodyFat}%`);
                }
                if (healthData.muscleMass) {
                    doc.text(`Muscle Mass: ${healthData.muscleMass} kg`);
                }
                doc.moveDown(2);
            }

            // Footer
            doc.fontSize(9).fillColor('#999');
            doc.text('Generated by RELIV Kiosk', 50, doc.page.height - 100, { align: 'center' });
            doc.text('This report is for informational purposes only.', { align: 'center' });
            doc.text('Consult a healthcare professional for medical advice.', { align: 'center' });

            doc.end();
        });
    }

    /**
     * Create receipt PDF
     * @private
     */
    async _createReceiptPDF(customerData, transaction, ecoStats = null) {
        return new Promise((resolve, reject) => {
            try {
                const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
                const chunks = [];

                doc.on('data', chunk => chunks.push(chunk));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', reject);

                const normalized = normalizeReceiptData(customerData, transaction, ecoStats);
                drawReceiptDocument(doc, normalized);

                doc.end();
            } catch (err) {
                reject(err);
            }
        });
    }
}

export default PDFGenerator;
export { PDFGenerator };
