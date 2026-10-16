// Completion and stock commit must be synchronous and use the same SQLite connection.
export function finalizeDispenseAck(db, fulfillment, inventory, jobId, ack) {
    if (!inventory) throw new Error('Inventory service unavailable; delivery cannot be finalized.');
    return db.transaction(() => {
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
