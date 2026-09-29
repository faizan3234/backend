import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initPaymentV2Schema } from './paymentV2Db.js';
import { sendPaymentReceipt } from './services/receiptEmailService.js';

test('concurrent receipt requests send once; failed SMTP can be retried without paying again', async () => {
    const db = new Database(':memory:');
    initPaymentV2Schema(db);
    const order = { request_id: 'REQ-CONCURRENT', order_id: 'order_test', status: 'PAID', razorpay_payment_id: 'pay_test', amount: 536, currency: 'INR', service_type: 'MEDICINE' };
    let sends = 0, rejectSend;
    const params = { db, order, email: 'buyer@example.com', pdfBuilderOverride: async () => Buffer.from('receipt'),
        transporter: { sendMail: () => { sends++; return new Promise((_resolve, reject) => { rejectSend = reject; }); } } };
    try {
        const results = Promise.allSettled([sendPaymentReceipt(params), sendPaymentReceipt(params)]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(sends, 1);
        rejectSend(new Error('SMTP unavailable'));
        assert.ok((await results).every(result => result.status === 'rejected'));
        params.transporter.sendMail = async () => { sends++; return { messageId: 'receipt_test' }; };
        const retry = await Promise.all([sendPaymentReceipt(params), sendPaymentReceipt(params)]);
        assert.ok(retry.every(result => result.sent));
        assert.equal(sends, 2);
        assert.equal((await sendPaymentReceipt(params)).alreadySent, true);
        assert.equal(sends, 2);
        assert.equal(db.prepare("SELECT COUNT(*) n FROM payment_v2_receipts WHERE status='SENT'").get().n, 1);
    } finally { db.close(); }
});
