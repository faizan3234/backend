// Signed physical stock plus a separately labelled projection for this order.
export function lowStockSnapshot(db, observedAt, cart = []) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory'").get()) return [];
    const revisions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_revisions'").get();
    const purchases = new Map();
    for (const item of cart) {
        const id = item.kitId || item.kit_id || item.id;
        const quantity = item.quantity;
        if (id && Number.isSafeInteger(quantity) && quantity > 0)
            purchases.set(id, (purchases.get(id) || 0) + quantity);
    }
    const rows = revisions ? db.prepare(`SELECT i.*,r.revision FROM inventory i
        JOIN inventory_revisions r ON r.kit_id=i.kit_id
        ORDER BY r.relay_seq,i.quantity,i.kit_id`).all() : db.prepare(`SELECT * FROM inventory
        ORDER BY quantity,kit_id`).all();
    return rows
        .filter(row => row.quantity >= 0 && (row.quantity <= 2 ||
            (purchases.has(row.kit_id) && purchases.get(row.kit_id) <= row.quantity && row.quantity - purchases.get(row.kit_id) <= 2)))
        // Keep the purchasing customer's warning ahead of unrelated telemetry.
        .sort((a,b) => Number(purchases.has(b.kit_id)) - Number(purchases.has(a.kit_id)))
        .filter(row => Number.isSafeInteger(row.quantity) && Number.isFinite(row.price) && row.price >= 0 && String(row.kit_id).length <= 80)
        .slice(0,8)
        .map(row => ({ id: String(row.kit_id), name: String(row.name).slice(0,100),
            quantity: row.quantity,
            ...(purchases.has(row.kit_id) && purchases.get(row.kit_id) <= row.quantity
                ? { purchasedQuantity: purchases.get(row.kit_id) } : {}),
            unitPricePaise: Math.round(row.price * 100),
            revision: row.revision ? `r${row.revision}` : String(row.updated_at), observedAt }));
}
