// Physical inventory at QR creation, never reserved/estimated post-dispense stock.
export function lowStockSnapshot(db, observedAt) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory'").get()) return [];
    const revisions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_revisions'").get();
    const rows = revisions ? db.prepare(`SELECT i.*,r.revision FROM inventory i
        JOIN inventory_revisions r ON r.kit_id=i.kit_id WHERE i.quantity BETWEEN 0 AND 2
        ORDER BY r.relay_seq,i.quantity,i.kit_id LIMIT 8`).all() : db.prepare(`SELECT * FROM inventory
        WHERE quantity BETWEEN 0 AND 2 ORDER BY quantity,kit_id LIMIT 8`).all();
    return rows
        .filter(row => Number.isSafeInteger(row.quantity) && Number.isFinite(row.price) && row.price >= 0 && String(row.kit_id).length <= 80)
        .map(row => ({ id: String(row.kit_id), name: String(row.name).slice(0,100),
            quantity: row.quantity, unitPricePaise: Math.round(row.price * 100),
            revision: row.revision ? `r${row.revision}` : String(row.updated_at), observedAt }));
}
