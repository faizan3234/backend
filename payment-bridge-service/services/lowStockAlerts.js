import crypto from 'node:crypto';
import { createReceiptTransporter, isReceiptEmailConfigured } from './receiptEmailService.js';

export function validateLowStock(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid low stock snapshot');
    return value.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 80 ||
            typeof item.name !== 'string' || !item.name || item.name.length > 100 ||
            !Number.isSafeInteger(item.quantity) || item.quantity < 0 || item.quantity > 2 ||
            !Number.isSafeInteger(item.unitPricePaise) || item.unitPricePaise < 0 ||
            typeof item.revision !== 'string' || !item.revision || item.revision.length > 40 ||
            !Number.isSafeInteger(item.observedAt) || item.observedAt <= 0 || item.observedAt > 8640000000000000) throw new Error('Invalid low stock snapshot');
        return { id:item.id, name:item.name, quantity:item.quantity, unitPricePaise:item.unitPricePaise,
            revision:item.revision, observedAt:item.observedAt };
    });
}

// Only server-owned SMTP. No customer mailbox, patient identity, or health data.
export async function sendLowStockAlerts({ db, requestId, transporter = null }) {
    const order = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id=?').get(requestId);
    if (!order || order.status !== 'PAID' || !order.razorpay_payment_id) return;
    // Do not send days-old inventory as a new operational alert. This uses
    // Oracle's receipt time, so a badly set Pi clock cannot extend the window.
    if (order.created_at < Date.now() - 24 * 60 * 60 * 1000) return;
    const outcome = { retry: false, review: false };
    const stock = validateLowStock(JSON.parse(order.low_stock_json || '[]'));
    if (!stock.length) return;
    const sender = 'relivcustomercare.in@gmail.com';
    if (!transporter && (!isReceiptEmailConfigured() || process.env.RECEIPT_GMAIL_USER?.trim().toLowerCase() !== sender)) {
        throw new Error('Configure the Reliv operations mailbox on the bridge');
    }
    const mailer = transporter || createReceiptTransporter();
    for (const item of stock) {
        // Same inventory revision relayed by many customers sends only once.
        const key = crypto.createHash('sha256').update(JSON.stringify([
            order.kiosk_id, item.id, item.quantity, item.revision
        ])).digest('hex');
        const newer = db.prepare(`SELECT 1 FROM payment_v2_orders o,
            json_each(CASE WHEN json_valid(o.low_stock_json) THEN o.low_stock_json ELSE '[]' END) j
            WHERE o.status='PAID' AND o.razorpay_payment_id IS NOT NULL
            AND o.kiosk_id=? AND json_extract(j.value,'$.id')=?
            AND json_extract(j.value,'$.observedAt') > ? LIMIT 1`)
            .get(order.kiosk_id,item.id,item.observedAt);
        if (newer) continue; // A newer signed snapshot supersedes this item.
        const now = Date.now();
        const claimed = db.prepare(`INSERT INTO low_stock_alerts(event_key,request_id,status,updated_at)
            VALUES (?,?,'SENDING',?) ON CONFLICT(event_key) DO UPDATE SET status='SENDING',updated_at=excluded.updated_at
            WHERE low_stock_alerts.status='FAILED' AND low_stock_alerts.updated_at < ?`).run(key,requestId,now,now-60000);
        if (!claimed.changes) {
            const previous = db.prepare('SELECT status FROM low_stock_alerts WHERE event_key=?').get(key);
            outcome.review ||= previous?.status === 'UNKNOWN';
            outcome.retry ||= ['FAILED','SENDING'].includes(previous?.status);
            continue;
        }
        try {
            const result = await mailer.sendMail({
                from: `"Reliv Stock Alerts" <${sender}>`, to: 'khanfaizan3234@gmail.com',
                subject: `Reliv low stock: ${item.quantity} left at QR creation`,
                text: `Kiosk: ${order.kiosk_id}\nMedicine: ${item.name}\nItem ID: ${item.id}\nPhysical quantity at QR creation: ${item.quantity}\nUnit price: INR ${(item.unitPricePaise/100).toFixed(2)}\nObserved: ${new Date(item.observedAt).toISOString()}\nInventory revision: ${item.revision}\n\nThis signed snapshot was carried by a customer's phone. It predates dispensing for this payment and is not confirmation of delivery or the current stock. Check the kiosk before replenishment.`,
                messageId: `<stock-${key}@reliv.in>`
            });
            if (Array.isArray(result?.accepted) && !result.accepted.length) {
                const rejected = new Error('Operations recipient rejected');
                rejected.responseCode = 550;
                throw rejected;
            }
            db.prepare("UPDATE low_stock_alerts SET status='SENT',updated_at=? WHERE event_key=?").run(Date.now(),key);
        } catch (error) {
            // A lost SMTP acknowledgement may already have delivered the message.
            // Only explicit rejection / pre-connection errors are safe to retry.
            const retryable = (error.responseCode >= 400 && error.responseCode < 600) ||
                ['EAUTH','ECONNECTION','EDNS'].includes(error.code);
            db.prepare('UPDATE low_stock_alerts SET status=?,updated_at=? WHERE event_key=?')
                .run(retryable ? 'FAILED' : 'UNKNOWN', Date.now(), key);
            throw error;
        }
    }
    return outcome;
}
