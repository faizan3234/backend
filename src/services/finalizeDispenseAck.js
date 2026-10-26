import { recordLateDispenseAck } from './lateDispenseAck.js';
// Completion and stock commit must be synchronous and use the same SQLite connection.
export function finalizeDispenseAck(db, fulfillment, inventory, jobId, ack) {
    if (!inventory) throw new Error('Inventory service unavailable; delivery cannot be finalized.');
    return db.transaction(() => {
        const before = fulfillment.getJobStatus(jobId);
        if (before?.state === 'MANUAL_REVIEW_REQUIRED') {
            if (recordLateDispenseAck(db, before, ack)) {
                console.warn(`[Fulfillment] Late motor result saved for ${jobId}; staff review retained, stock unchanged.`);
            }
            return false; // Preserve manual review and inventory exactly as they are.
        }
        if (!fulfillment.markCompleted(jobId, ack)) return false;
        const job = fulfillment.getJobStatus(jobId);
        const rows = db.prepare(`SELECT quantity FROM inventory_reservations
            WHERE transaction_id=? AND kit_id=? AND status IN ('RESERVED','COMMITTED')`).all(job.transaction_id, job.kit_id);
        if (rows.reduce((sum, row) => sum + row.quantity, 0) !== job.quantity) {
            throw new Error('Inventory reservation mismatch; staff review required.');
        }
        inventory.deductInventory(job.transaction_id, jobId, job.kit_id);
        return true;
    })();
}

