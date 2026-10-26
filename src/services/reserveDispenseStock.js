import InventoryManager from './inventoryManager.js';

// Called inside the same SQLite transaction as the PENDING -> IN_PROGRESS claim.
// Payment V2 does not use the legacy checkout's reservation step.
export function reserveDispenseStock(db, job) {
  if (job.state !== 'PENDING' || job.mqtt_published_at) {
    throw new Error('Previously dispatched order requires staff review; never reserve and redispatch.');
  }
  const transaction = db.prepare('SELECT * FROM transactions WHERE transaction_id=?').get(job.transaction_id);
  if (!transaction || transaction.session_id !== job.session_id ||
      !['VERIFIED', 'FULFILLED'].includes(transaction.status)) {
    throw new Error('A matching verified payment is required before dispensing.');
  }
  let cart;
  try { cart = JSON.parse(transaction.cart); } catch { cart = null; }
  const items = Array.isArray(cart) ? cart.filter(item =>
    (item.kit_id || item.id || item.inventory_id) === job.kit_id) : [];
  const quantities = items.map(item => Number(item.quantity ?? item.cartQuantity ?? 1));
  if (!Number.isInteger(job.quantity) || job.quantity <= 0 || !quantities.length ||
      quantities.some(q => !Number.isInteger(q) || q <= 0) ||
      quantities.reduce((sum, q) => sum + q, 0) !== job.quantity) {
    throw new Error('Dispense quantity does not match the paid cart; staff review required.');
  }
  const rows = db.prepare(`SELECT quantity, status FROM inventory_reservations
    WHERE transaction_id=? AND kit_id=? AND status IN ('RESERVED','COMMITTED')`)
    .all(job.transaction_id, job.kit_id);
  const inventory = new InventoryManager(db);
  if (rows.length) {
    if (rows.some(r => r.status !== 'RESERVED') ||
        rows.reduce((sum, r) => sum + r.quantity, 0) !== job.quantity) {
      throw new Error('Inventory reservation mismatch before dispatch; staff review required.');
    }
    const item = inventory.getInventoryItem(job.kit_id);
    if (!item || item.quantity < item.reserved_quantity) {
      throw new Error('Reserved stock is no longer available; staff review required.');
    }
    return; // Legacy checkout already reserved it. Never reserve twice.
  }
  inventory.reserveInventory(job.transaction_id, 'MEDICINE', [
    { kit_id: job.kit_id, quantity: job.quantity }
  ]);
}
