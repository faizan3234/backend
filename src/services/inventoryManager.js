/**
 * Inventory Manager
 * 
 * Manages medicine stock, reservations, and dispense integration
 * 
 * OFFLINE-FIRST ARCHITECTURE:
 * - All inventory stored in local SQLite (`inventory` and `inventory_reservations` tables)
 * - Medicine selection comes from transaction/cart data and resolves `kit_id` against inventory
 * - Stock reservations prevent overselling using `inventory_reservations`
 * - Automatic inventory deduction on dispense confirmation
 * 
 * SCHEMA:
 * - inventory: kit_id, name, price, quantity, motor_id, description, updated_at, synced_to_mongo
 * - inventory_reservations: reservation_id, transaction_id, kit_id, quantity, status, created_at, resolved_at
 */

export class InventoryManager {
  constructor(db) {
    if (!db) {
      throw new Error('[InventoryManager] Database instance required');
    }
    this.db = db;
    console.log('[InventoryManager] Initialized');
  }

  /**
   * Internal helper to format database rows with backward-compatible aliases
   * @private
   */
  _formatItem(row) {
    if (!row) return null;
    const quantity = Number(row.quantity ?? 0);
    const reserved = Number(row.reserved_quantity ?? 0);
    const available = Math.max(0, quantity - reserved);
    const price = Number(row.price ?? 0);

    return {
      kit_id: row.kit_id,
      name: row.name,
      price: price,
      quantity: quantity,
      motor_id: row.motor_id,
      description: row.description,

      image_path: row.image_path || '',
      imageUrl: row.image_path || '',

      updated_at: row.updated_at,
      synced_to_mongo: row.synced_to_mongo,

      // Backward-compatible aliases for legacy callers/APIs
      id: row.kit_id,
      stock_quantity: quantity,
      reserved_quantity: reserved,
      available_quantity: available,
      unit_price: price,
      category: 'MEDICINE',
      min_stock_level: 2,
      max_stock_level: 100
    };
  }

  /**
   * Get all inventory items with computed reservation and available levels
   */
  getAllInventory() {
    const rows = this.db.prepare(`
      SELECT 
        i.kit_id,
        i.name,
        i.price,
        i.quantity,
        i.motor_id,
        i.description,
        i.image_path,
        i.updated_at,
        i.synced_to_mongo,
        COALESCE(
          (SELECT SUM(r.quantity) 
           FROM inventory_reservations r 
           WHERE r.kit_id = i.kit_id AND r.status = 'RESERVED'), 0
        ) as reserved_quantity
      FROM inventory i
      ORDER BY i.name
    `).all();

    return rows.map(row => this._formatItem(row));
  }

  /**
   * Get inventory item by kit_id (or legacy id)
   */
  getInventoryItem(itemId) {
    const row = this.db.prepare(`
      SELECT 
        i.kit_id,
        i.name,
        i.price,
        i.quantity,
        i.motor_id,
        i.description,
        i.image_path,
        i.updated_at,
        i.synced_to_mongo,
        COALESCE(
          (SELECT SUM(r.quantity) 
           FROM inventory_reservations r 
           WHERE r.kit_id = i.kit_id AND r.status = 'RESERVED'), 0
        ) as reserved_quantity
      FROM inventory i
      WHERE i.kit_id = ?
    `).get(itemId);

    return this._formatItem(row);
  }

  /**
   * Get inventory for medicine services
   * Medicine selection comes from transaction/cart data resolving kit_ids against inventory.
   */
  getInventoryByService(serviceType) {
    if (serviceType === 'HEALTH_CHECKUP') {
      return [];
    }

    return this.getAllInventory();
  }

  /**
   * Check stock availability for a cart or service
   * Resolves kit_ids against inventory available stock (quantity - reserved_quantity)
   */
  checkStockAvailability(serviceType, cart = []) {
    if (serviceType === 'HEALTH_CHECKUP') {
      return { available: true, items: [], unavailableItems: [] };
    }

    // Check specific cart items if provided
    if (Array.isArray(cart) && cart.length > 0) {
      const unavailableItems = [];
      for (const cartItem of cart) {
        const kitId = cartItem.kit_id || cartItem.id;
        const requiredQty = cartItem.quantity || 1;
        const item = this.getInventoryItem(kitId);

        if (!item || item.available_quantity < requiredQty) {
          unavailableItems.push({
            kit_id: kitId,
            name: item ? item.name : (cartItem.name || kitId),
            requested_quantity: requiredQty,
            available_quantity: item ? item.available_quantity : 0
          });
        }
      }

      return {
        available: unavailableItems.length === 0,
        items: this.getAllInventory(),
        unavailableItems
      };
    }

    // General availability across inventory
    const items = this.getAllInventory();
    const unavailableItems = items.filter(item => item.available_quantity <= 0);

    return {
      available: unavailableItems.length === 0,
      items,
      unavailableItems
    };
  }

  /**
   * Reserve inventory for a session or transaction based on transaction/cart items
   */
  reserveInventory(sessionIdOrTxnId, serviceType, cart = []) {
    if (serviceType === 'HEALTH_CHECKUP') {
      return [];
    }

    let txnId = sessionIdOrTxnId;
    let targetCart = Array.isArray(cart) ? cart : [];

    // Resolve transaction ID from database if session_id was passed.
    const txnRow = this.db.prepare(`
      SELECT transaction_id, cart
      FROM transactions
      WHERE session_id = ? OR transaction_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionIdOrTxnId, sessionIdOrTxnId);

    if (txnRow) {
      txnId = txnRow.transaction_id;

      // Only use transaction cart when an explicit cart wasn't supplied.
      if (targetCart.length === 0 && txnRow.cart) {
        try {
          targetCart = JSON.parse(txnRow.cart);
        } catch (e) {
          targetCart = [];
        }
      }
    }

    // MEDICINE orders MUST have an explicit cart.
    // Never silently reserve the entire inventory.
    if (serviceType === 'MEDICINE' && targetCart.length === 0) {
      throw new Error('Medicine reservation requires cart items');
    }

    // Normalize cart fields.
    targetCart = targetCart.map(item => ({
      kit_id: item.kit_id || item.id || item.inventory_id,
      quantity: Number(item.quantity ?? item.cartQuantity ?? 1)
    }));

    for (const item of targetCart) {
      if (!item.kit_id) {
        throw new Error('Reservation item is missing kit_id');
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new Error(`Invalid reservation quantity for ${item.kit_id}`);
      }
    }

    const reserved = [];
    const reserveTxn = this.db.transaction(() => {
      for (const item of targetCart) {
        const kitId = item.kit_id;
        const qty = item.quantity;

        const resId = `RES-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        const current = this.getInventoryItem(kitId);
        if (!current) {
          throw new Error(`Inventory item not found: ${kitId}`);
        }

        if (current.available_quantity < qty) {
          throw new Error(
            `Insufficient stock for ${kitId}: ` +
            `have ${current.available_quantity}, requested ${qty}`
          );
        }

        this.db.prepare(`
          INSERT INTO inventory_reservations (
            reservation_id, transaction_id, kit_id, quantity, status, created_at
          ) VALUES (?, ?, ?, ?, 'RESERVED', datetime('now'))
        `).run(resId, txnId, kitId, qty);

        reserved.push({
          reservation_id: resId,
          transaction_id: txnId,
          kit_id: kitId,
          quantity: qty
        });
      }
    });

    try {
      reserveTxn();
      console.log(`[InventoryManager] Reserved ${reserved.length} item(s) for ${sessionIdOrTxnId}`);
    } catch (err) {
      // Re-throw so the caller's outer SQLite transaction can roll back fully.
      throw err;
    }

    return reserved;
  }

  /**
   * Release reserved inventory (mark status ROLLED_BACK)
   */
  releaseReservation(sessionIdOrTxnId) {
    const rows = this.db.prepare(`
      SELECT r.reservation_id, r.kit_id, r.quantity
      FROM inventory_reservations r
      LEFT JOIN transactions t ON r.transaction_id = t.transaction_id
      WHERE (t.session_id = ? OR r.transaction_id = ?) AND r.status = 'RESERVED'
    `).all(sessionIdOrTxnId, sessionIdOrTxnId);

    if (rows.length === 0) {
      console.log(`[InventoryManager] No active reservations to release for ${sessionIdOrTxnId}`);
      return [];
    }

    const releaseTxn = this.db.transaction(() => {
      for (const row of rows) {
        this.db.prepare(`
          UPDATE inventory_reservations
          SET status = 'ROLLED_BACK', resolved_at = datetime('now')
          WHERE reservation_id = ?
        `).run(row.reservation_id);
      }
    });

    releaseTxn();
    console.log(`[InventoryManager] Released ${rows.length} reservation(s) for ${sessionIdOrTxnId}`);
    return rows;
  }

  /**
   * Deduct inventory after successful dispense (mark status COMMITTED and subtract quantity)
   * If kitId is provided, commits and deducts only the reservation for that specific kit.
   */
  deductInventory(sessionIdOrTxnId, dispenseJobId, kitId = null) {
    let rows;
    if (kitId) {
      rows = this.db.prepare(`
        SELECT r.reservation_id, r.kit_id, r.quantity
        FROM inventory_reservations r
        LEFT JOIN transactions t ON r.transaction_id = t.transaction_id
        WHERE (t.session_id = ? OR r.transaction_id = ?) AND r.kit_id = ? AND r.status = 'RESERVED'
      `).all(sessionIdOrTxnId, sessionIdOrTxnId, kitId);
    } else {
      rows = this.db.prepare(`
        SELECT r.reservation_id, r.kit_id, r.quantity
        FROM inventory_reservations r
        LEFT JOIN transactions t ON r.transaction_id = t.transaction_id
        WHERE (t.session_id = ? OR r.transaction_id = ?) AND r.status = 'RESERVED'
      `).all(sessionIdOrTxnId, sessionIdOrTxnId);
    }

    if (rows.length === 0) {
      console.log(`[InventoryManager] No RESERVED inventory found to deduct for ${sessionIdOrTxnId}${kitId ? ` (kit: ${kitId})` : ''}`);
      return [];
    }

    const deductTxn = this.db.transaction(() => {
      for (const r of rows) {
        this.db.prepare(`
          UPDATE inventory_reservations
          SET status = 'COMMITTED', resolved_at = datetime('now')
          WHERE reservation_id = ?
        `).run(r.reservation_id);

        this.db.prepare(`
          UPDATE inventory
          SET quantity = MAX(0, quantity - ?), updated_at = datetime('now')
          WHERE kit_id = ?
        `).run(r.quantity, r.kit_id);
      }
    });

    deductTxn();
    console.log(`[InventoryManager] Deducted ${rows.length} item(s) for dispense job ${dispenseJobId}${kitId ? ` (kit: ${kitId})` : ''}`);
    return rows;
  }

  /**
   * Get inventory transaction history for a session
   */
  getSessionInventoryHistory(sessionId) {
    const history = this.db.prepare(`
      SELECT 
        r.reservation_id as id,
        r.kit_id as inventory_id,
        r.kit_id,
        i.name as item_name,
        r.status as transaction_type,
        r.quantity,
        r.created_at
      FROM inventory_reservations r
      LEFT JOIN transactions t ON r.transaction_id = t.transaction_id
      JOIN inventory i ON r.kit_id = i.kit_id
      WHERE t.session_id = ? OR r.transaction_id = ?
      ORDER BY r.created_at ASC
    `).all(sessionId, sessionId);

    return history;
  }

  /**
   * Get low stock items (available quantity below threshold)
   */
  getLowStockItems(threshold = 2) {
    const items = this.getAllInventory();
    return items.filter(item => item.available_quantity <= threshold);
  }

  /**
   * Get expiring items
   * Note: Expiry dates are not present in active SQLite schema, returns [] cleanly
   */
  getExpiringItems(daysAhead = 30) {
    return [];
  }

  /**
   * Add stock (purchase/restock)
   */
  addStock(itemId, quantity, notes = 'Stock added') {
    const item = this.getInventoryItem(itemId);
    if (!item) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    this.db.prepare(`
      UPDATE inventory
      SET quantity = quantity + ?, updated_at = datetime('now')
      WHERE kit_id = ?
    `).run(quantity, itemId);

    console.log(`[InventoryManager] Added ${quantity} units to kit ${itemId}`);
    return this.getInventoryItem(itemId);
  }

  /**
   * Manual stock adjustment
   */
  adjustStock(itemId, quantity, notes) {
    const item = this.getInventoryItem(itemId);
    if (!item) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    this.db.prepare(`
      UPDATE inventory
      SET quantity = MAX(0, quantity + ?), updated_at = datetime('now')
      WHERE kit_id = ?
    `).run(quantity, itemId);

    console.log(`[InventoryManager] Adjusted kit ${itemId} by ${quantity} units (${notes || 'No notes'})`);
    return this.getInventoryItem(itemId);
  }
}

export default InventoryManager;
