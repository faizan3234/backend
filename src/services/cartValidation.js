// Matches the ESP32 contract: at most ten cycles per item/job.
export const MAX_DISPENSE_QUANTITY = 10;
export function canonicalMedicineCart(cart) {
    if (!Array.isArray(cart)) throw Object.assign(new Error('Invalid medicine cart.'), {code:'INVALID_CART_ITEM',status:400});
    const quantities = new Map();
    for (const item of cart) {
        const id = item && String(item.kit_id ?? item._id ?? item.id ?? item.inventory_id ?? '').trim();
        const raw = item?.cartQuantity ?? item?.quantityRequested ?? item?.selectedQuantity ?? item?.quantity;
        const quantity = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
        if (!id) throw Object.assign(new Error('Missing medicine ID.'), {code:'MISSING_KIT_ID',status:400});
        const total = (quantities.get(id) || 0) + quantity;
        if (!Number.isSafeInteger(quantity) || quantity < 1 || total > MAX_DISPENSE_QUANTITY) {
            throw Object.assign(new Error(`Choose 1–${MAX_DISPENSE_QUANTITY} units per medicine.`), {code:'INVALID_QUANTITY',status:400});
        }
        quantities.set(id,total);
    }
    return [...quantities].map(([kit_id,quantity])=>({kit_id,quantity})).sort((a,b)=>a.kit_id.localeCompare(b.kit_id));
}
