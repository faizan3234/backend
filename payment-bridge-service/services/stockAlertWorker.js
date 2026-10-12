import { sendLowStockAlerts } from './lowStockAlerts.js';

const LEASE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

// The paid order is durable work: a crash before enqueue is recovered by the worker.
export async function processStockAlertRequest({ db, requestId, transporter = null }) {
    const now = Date.now();
    const order = db.prepare(`SELECT request_id FROM payment_v2_orders
        WHERE request_id=? AND status='PAID' AND razorpay_payment_id IS NOT NULL
        AND low_stock_json IS NOT NULL AND low_stock_json != '[]'`).get(requestId);
    if (!order) return;
    const claim = db.prepare(`INSERT INTO low_stock_dispatch(request_id,status,next_attempt_at)
        VALUES (?,'WORKING',?) ON CONFLICT(request_id) DO UPDATE SET status='WORKING',next_attempt_at=excluded.next_attempt_at
        WHERE low_stock_dispatch.status IN ('RETRY','WORKING') AND low_stock_dispatch.next_attempt_at <= ?`)
        .run(requestId,now + LEASE_MS,now);
    if (!claim.changes) return;
    // A previous worker may have died during SMTP. Never blindly resend it.
    db.prepare("UPDATE low_stock_alerts SET status='UNKNOWN' WHERE status='SENDING' AND updated_at < ?").run(now - LEASE_MS);
    try {
        const result = await sendLowStockAlerts({db,requestId,transporter});
        const status = result?.retry ? 'RETRY' : result?.review ? 'REVIEW' : 'DONE';
        db.prepare('UPDATE low_stock_dispatch SET status=?,next_attempt_at=? WHERE request_id=?')
            .run(status,Date.now()+RETRY_MS,requestId);
        if (result?.review) console.warn('[LowStock] Delivery uncertain; reconcile UNKNOWN entries before retrying.');
    } catch {
        db.prepare("UPDATE low_stock_dispatch SET status='RETRY',next_attempt_at=? WHERE request_id=?")
            .run(Date.now()+RETRY_MS,requestId);
        console.warn('[LowStock] Dispatch deferred; retry retained on Oracle.');
    }
}

export function createStockAlertWorker({ db, transporter = null, intervalMs = 30000 }) {
    let timer = null, active = null, stopped = false;
    function runOnce() {
        if (stopped) return Promise.resolve();
        if (active) return active;
        active = (async () => {
            // Finished requests cannot starve newer alerts. Bound work each tick.
            const due = db.prepare(`SELECT o.request_id FROM payment_v2_orders o
                LEFT JOIN low_stock_dispatch d ON d.request_id=o.request_id
                WHERE o.status='PAID' AND o.razorpay_payment_id IS NOT NULL
                AND o.low_stock_json IS NOT NULL AND o.low_stock_json != '[]'
                AND (d.request_id IS NULL OR (d.status IN ('RETRY','WORKING') AND d.next_attempt_at <= ?))
                ORDER BY COALESCE(d.next_attempt_at,0),o.created_at LIMIT 10`).all(Date.now());
            for (const order of due) {
                if (stopped) break;
                await processStockAlertRequest({db,requestId:order.request_id,transporter});
            }
        })().finally(() => { active = null; });
        return active;
    }
    return {
        runOnce,
        start() {
            if (timer || stopped) return;
            const tick = () => { void runOnce().catch(() => console.warn('[LowStock] Worker unavailable; durable requests remain queued.')); };
            timer = setInterval(tick,intervalMs); timer.unref?.(); tick();
        },
        async stop() { stopped = true; clearInterval(timer); timer = null; await active; }
    };
}
