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

// An absolute count from an old admin form must not undo a completed sale.
export function assertExpectedStock(item, expectedQuantity) {
    if (expectedQuantity === undefined) {
        throw Object.assign(new Error('Refresh inventory before changing stock. This admin page needs the latest stock count.'), {status:428,code:'STOCK_REFRESH_REQUIRED'});
    }
    const expected = stockInteger(expectedQuantity);
    if (expected !== item.quantity) {
        throw Object.assign(new Error('Stock changed while this form was open. Close the form, refresh inventory, and check the current count before saving.'), {status:409,code:'STOCK_CHANGED'});
    }
}
export function medicineText(value, label, maxLength, {optional=false}={}) {
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.trim().length > maxLength)
        throw Object.assign(new Error(`${label} must be ${optional ? 'text' : 'non-empty text'} of at most ${maxLength} characters.`), {status:400});
    return value.trim();
}
export function medicinePrice(value) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
        throw Object.assign(new Error('Enter a valid medicine price.'), {status:400});
    const price = Number(value);
    // Keep ten-item cart arithmetic exact in integer paise.
    if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(Math.round(price * 100) * 10))
        throw Object.assign(new Error('Enter a valid medicine price.'), {status:400});
    return price;
}
