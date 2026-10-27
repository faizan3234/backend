function conflict(message) { return Object.assign(new Error(message), {status:409}); }
export function stockInteger(value, {signed=false}={}) {
    if ((typeof value!=='number' && typeof value!=='string') || String(value).trim()==='') throw Object.assign(new Error('Enter a whole-number stock quantity.'),{status:400});
    const n=Number(value);
    if (!Number.isSafeInteger(n)||(!signed&&n<0)) throw Object.assign(new Error('Enter a whole-number stock quantity.'),{status:400});
    return n;
}
export function assertStockFloor(item,nextQuantity) {
    stockInteger(nextQuantity);
    if (nextQuantity<item.reserved_quantity) throw conflict('This stock is reserved for an order. Reconcile that order before reducing the count.');
}
// Frozen payment carts still reference this slot. Never substitute another medicine
// while a customer could pay, activate, or need reconciliation.
export function assertKitCanBeReassigned(db,kitId) {
    const reserved=db.prepare("SELECT 1 FROM inventory_reservations WHERE kit_id=? AND status='RESERVED' LIMIT 1").get(kitId);
    const jobs=db.prepare("SELECT 1 FROM fulfillment_jobs WHERE kit_id=? AND state!='COMPLETED' LIMIT 1").get(kitId);
    const pending=db.prepare(`SELECT 1 FROM transactions t, json_each(CASE WHEN json_valid(t.cart) THEN t.cart ELSE '[]' END) c
      WHERE t.status IN ('CREATED','PENDING','VERIFIED')
      AND COALESCE(json_extract(c.value,'$.kit_id'),json_extract(c.value,'$.id'),json_extract(c.value,'$.inventory_id'))=?
      AND NOT EXISTS (SELECT 1 FROM fulfillment_jobs f WHERE f.transaction_id=t.transaction_id AND f.kit_id=COALESCE(json_extract(c.value,'$.kit_id'),json_extract(c.value,'$.id'),json_extract(c.value,'$.inventory_id')) AND f.state='COMPLETED')
      AND (t.status='VERIFIED' OR EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=t.session_id AND julianday(s.expires_at)>julianday('now'))) LIMIT 1`).get(kitId);
    if (reserved||jobs||pending) throw conflict('An order still references this item. Finish or reconcile it before renaming, moving or deleting this slot.');
}
