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
            !Number.isSafeInteger(item.observedAt) || item.observedAt <= 0) throw new Error('Invalid low stock snapshot');
        return { id:item.id, name:item.name, quantity:item.quantity, unitPricePaise:item.unitPricePaise,
            revision:item.revision, observedAt:item.observedAt };
    });
}

// Only server-owned SMTP. No customer mailbox, patient identity, or health data.
export async function sendLowStockAlerts({ db, requestId, transporter = null }) {
    const order = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id=?').get(requestId);
    if (!order || order.status !== 'PAID' || !order.razorpay_payment_id) return;
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
        const now = Date.now();
        const claimed = db.prepare(`INSERT INTO low_stock_alerts(event_key,request_id,status,updated_at)
            VALUES (?,?,'SENDING',?) ON CONFLICT(event_key) DO UPDATE SET status='SENDING',updated_at=excluded.updated_at
            WHERE low_stock_alerts.status='FAILED' AND low_stock_alerts.updated_at < ?`).run(key,requestId,now,now-60000);
        if (!claimed.changes) continue;
        try {
            await mailer.sendMail({
                from: `"Reliv Stock Alerts" <${sender}>`, to: 'khanfaizan3234@gmail.com',
                subject: `Reliv low stock: ${item.quantity} left at QR creation`,
                text: `Kiosk: ${order.kiosk_id}\nMedicine: ${item.name}\nItem ID: ${item.id}\nPhysical quantity at QR creation: ${item.quantity}\nUnit price: INR ${(item.unitPricePaise/100).toFixed(2)}\nObserved: ${new Date(item.observedAt).toISOString()}\nInventory revision: ${item.revision}\n\nThis signed snapshot was carried by a customer's phone. It predates dispensing for this payment and is not confirmation of delivery or the current stock. Check the kiosk before replenishment.`,
                messageId: `<stock-${key}@reliv.in>`
            });
            db.prepare("UPDATE low_stock_alerts SET status='SENT',updated_at=? WHERE event_key=?").run(Date.now(),key);
        } catch (error) {
            db.prepare("UPDATE low_stock_alerts SET status='FAILED',updated_at=? WHERE event_key=?").run(Date.now(),key);
            throw error;
        }
    }
}
