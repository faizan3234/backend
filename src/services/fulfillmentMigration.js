// Preserve motor evidence. Never silently delete completed ACKs to satisfy an index.
export function preserveFulfillmentJobs(db) {
    const duplicates=db.prepare('SELECT transaction_id,kit_id FROM fulfillment_jobs GROUP BY transaction_id,kit_id HAVING COUNT(*)>1').all();
    if (duplicates.length) {
        db.transaction(()=>{
            for(const row of duplicates) db.prepare(`UPDATE fulfillment_jobs SET state='MANUAL_REVIEW_REQUIRED',
                error_message='Duplicate legacy dispense records; staff must reconcile all records. No automatic retry.'
                WHERE transaction_id=? AND kit_id=? AND state IN ('PENDING','IN_PROGRESS','FAILED')`).run(row.transaction_id,row.kit_id);
        })();
        console.warn('[DB] Duplicate dispense records preserved for staff review; no motor replay allowed.');
        return false;
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_jobs_txn_kit ON fulfillment_jobs(transaction_id, kit_id)');
    return true;
}
export function assertSingleFulfillment(db,transactionId,kitId) {
    const {count}=db.prepare('SELECT COUNT(*) AS count FROM fulfillment_jobs WHERE transaction_id=? AND kit_id=?').get(transactionId,kitId);
    if(count>1) throw new Error('Duplicate dispense records require staff review; no motor command was sent.');
}
