// Physical inventory at QR creation, never reserved/estimated post-dispense stock.
export function lowStockSnapshot(db, observedAt) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory'").get()) return [];
    return db.prepare(`SELECT kit_id, name, quantity, price, updated_at FROM inventory
        WHERE quantity BETWEEN 0 AND 2 ORDER BY quantity, kit_id LIMIT 8`).all()
        .filter(row => Number.isSafeInteger(row.quantity) && Number.isFinite(row.price) && row.price >= 0)
        .map(row => ({ id: String(row.kit_id).slice(0,80), name: String(row.name).slice(0,100),
            quantity: row.quantity, unitPricePaise: Math.round(row.price * 100),
            revision: String(row.updated_at), observedAt }));
}
