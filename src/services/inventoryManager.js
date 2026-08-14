/**
 * Inventory Manager
 * 
 * Manages medicine stock, reservations, and dispense integration
 * 
 * OFFLINE-FIRST:
 * - All inventory stored in SQLite
 * - Stock reservations prevent overselling
 * - Automatic inventory deduction on dispense
 * - No dependency on internet/cloud
 * 
 * GOLDEN RULE:
 * - Inventory linked to session_id
 * - Reserved stock auto-releases if payment fails
 * - Dispensed quantity auto-deducted from stock
 */

import Database from 'better-sqlite3';

export class InventoryManager {
  constructor(db) {
    if (!db) {
      throw new Error('[InventoryManager] Database instance required');
    }
    this.db = db;
    console.log('[InventoryManager] Initialized');
  }

  /**
   * Get all inventory items
   */
  getAllInventory() {
    const items = this.db.prepare(`
      SELECT 
        id,
        name,
        description,
        category,
        stock_quantity,
        reserved_quantity,
        (stock_quantity - reserved_quantity) as available_quantity,
        unit_price,
        min_stock_level,
        max_stock_level,
        expiry_date,
        created_at,
        updated_at
      FROM inventory
      ORDER BY category, name
    `).all();

    return items;
  }

  /**
   * Get inventory item by ID
   */
  getInventoryItem(itemId) {
    const item = this.db.prepare(`
      SELECT 
        id,
        name,
        description,
        category,
        stock_quantity,
        reserved_quantity,
        (stock_quantity - reserved_quantity) as available_quantity,
        unit_price,
        min_stock_level,
        max_stock_level,
        expiry_date,
        created_at,
        updated_at
      FROM inventory
      WHERE id = ?
    `).get(itemId);

    return item || null;
  }

  /**
   * Get items by service type
   */
  getInventoryByService(serviceType) {
    try {
      const items = this.db.prepare(`
        SELECT 
          i.id,
          i.name,
          i.description,
          i.category,
          i.stock_quantity,
          i.reserved_quantity,
          (i.stock_quantity - i.reserved_quantity) as available_quantity,
          i.unit_price,
          i.min_stock_level,
          i.max_stock_level,
          i.expiry_date,
          sim.quantity as required_quantity,
          sim.included,
          sim.created_at,
          sim.updated_at
        FROM service_inventory_map sim
        JOIN inventory i ON sim.inventory_id = i.id
        WHERE sim.service_type = ?
        ORDER BY i.category, i.name
      `).all(serviceType);

      return items;
    } catch (err) {
      console.warn(`[InventoryManager] getInventoryByService error: ${err.message}`);
      return [];
    }
  }

  /**
   * Check if sufficient stock available for a service
   */
  checkStockAvailability(serviceType) {
    const items = this.getInventoryByService(serviceType);
    
    const unavailableItems = items.filter(item => {
      const availableQty = item.stock_quantity - item.reserved_quantity;
      return availableQty < item.required_quantity;
    });

    return {
      available: unavailableItems.length === 0,
      items,
      unavailableItems
    };
  }

  /**
   * Reserve inventory for a session
   * Called when payment is initiated
   */
  reserveInventory(sessionId, serviceType) {
    const items = this.getInventoryByService(serviceType);
    if (!items || items.length === 0) {
      console.log(`[InventoryManager] No inventory mapping for service: ${serviceType}`);
      return true;
    }

    const availability = this.checkStockAvailability(serviceType);
    
    if (!availability.available) {
      throw new Error(
        `Insufficient stock for service ${serviceType}. ` +
        `Missing: ${availability.unavailableItems.map(i => i.name).join(', ')}`
      );
    }

    // Start transaction
    const reserve = this.db.transaction((sessionId, serviceType) => {
      const items = this.getInventoryByService(serviceType);

      for (const item of items) {
        // Reserve the required quantity
        this.db.prepare(`
          UPDATE inventory
          SET 
            reserved_quantity = reserved_quantity + ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.required_quantity, item.id);

        // Log the reservation
        this.db.prepare(`
          INSERT INTO inventory_transactions (
            inventory_id,
            session_id,
            transaction_type,
            quantity,
            notes
          ) VALUES (?, ?, 'RESERVE', ?, ?)
        `).run(
          item.id,
          sessionId,
          item.required_quantity,
          `Reserved for service: ${serviceType}`
        );
      }

      return items;
    });

    const reservedItems = reserve(sessionId, serviceType);
    
    console.log(`[InventoryManager] Reserved inventory for session ${sessionId}: ${reservedItems.length} items`);
    
    return reservedItems;
  }

  /**
   * Release reserved inventory
   * Called when payment fails or session cancelled
   */
  releaseReservation(sessionId) {
    // Get all reserved items for this session
    const reservedItems = this.db.prepare(`
      SELECT 
        it.inventory_id,
        it.quantity,
        i.name
      FROM inventory_transactions it
      JOIN inventory i ON it.inventory_id = i.id
      WHERE it.session_id = ?
        AND it.transaction_type = 'RESERVE'
        AND NOT EXISTS (
          SELECT 1 FROM inventory_transactions it2
          WHERE it2.inventory_id = it.inventory_id
            AND it2.session_id = it.session_id
            AND it2.transaction_type = 'RELEASE'
        )
    `).all(sessionId);

    if (reservedItems.length === 0) {
      console.log(`[InventoryManager] No reservations to release for session ${sessionId}`);
      return [];
    }

    // Start transaction
    const release = this.db.transaction((sessionId, reservedItems) => {
      for (const item of reservedItems) {
        // Release the reservation
        this.db.prepare(`
          UPDATE inventory
          SET 
            reserved_quantity = reserved_quantity - ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.quantity, item.inventory_id);

        // Log the release
        this.db.prepare(`
          INSERT INTO inventory_transactions (
            inventory_id,
            session_id,
            transaction_type,
            quantity,
            notes
          ) VALUES (?, ?, 'RELEASE', ?, ?)
        `).run(
          item.inventory_id,
          sessionId,
          item.quantity,
          `Released reservation (payment failed/cancelled)`
        );
      }

      return reservedItems;
    });

    const releasedItems = release(sessionId, reservedItems);
    
    console.log(`[InventoryManager] Released reservation for session ${sessionId}: ${releasedItems.length} items`);
    
    return releasedItems;
  }

  /**
   * Deduct inventory after successful dispense
   * Called when ESP32 confirms dispensing complete
   */
  deductInventory(sessionId, dispenseJobId) {
    // Get all reserved items for this session that haven't been deducted
    const reservedItems = this.db.prepare(`
      SELECT 
        it.inventory_id,
        it.quantity,
        i.name
      FROM inventory_transactions it
      JOIN inventory i ON it.inventory_id = i.id
      WHERE it.session_id = ?
        AND it.transaction_type = 'RESERVE'
        AND NOT EXISTS (
          SELECT 1 FROM inventory_transactions it2
          WHERE it2.inventory_id = it.inventory_id
            AND it2.session_id = it.session_id
            AND it2.transaction_type = 'DEDUCT'
        )
    `).all(sessionId);

    if (reservedItems.length === 0) {
      console.log(`[InventoryManager] No reserved items to deduct for session ${sessionId}`);
      return [];
    }

    // Start transaction
    const deduct = this.db.transaction((sessionId, dispenseJobId, reservedItems) => {
      for (const item of reservedItems) {
        // Deduct from both stock_quantity and reserved_quantity
        this.db.prepare(`
          UPDATE inventory
          SET 
            stock_quantity = stock_quantity - ?,
            reserved_quantity = reserved_quantity - ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(item.quantity, item.quantity, item.inventory_id);

        // Log the deduction
        this.db.prepare(`
          INSERT INTO inventory_transactions (
            inventory_id,
            session_id,
            transaction_type,
            quantity,
            notes
          ) VALUES (?, ?, 'DEDUCT', ?, ?)
        `).run(
          item.inventory_id,
          sessionId,
          item.quantity,
          `Dispensed via job: ${dispenseJobId}`
        );
      }

      return reservedItems;
    });

    const deductedItems = deduct(sessionId, dispenseJobId, reservedItems);
    
    console.log(`[InventoryManager] Deducted inventory for session ${sessionId}: ${deductedItems.length} items`);
    
    return deductedItems;
  }

  /**
   * Get inventory transaction history for a session
   */
  getSessionInventoryHistory(sessionId) {
    const transactions = this.db.prepare(`
      SELECT 
        it.id,
        it.inventory_id,
        i.name as item_name,
        it.transaction_type,
        it.quantity,
        it.notes,
        it.created_at
      FROM inventory_transactions it
      JOIN inventory i ON it.inventory_id = i.id
      WHERE it.session_id = ?
      ORDER BY it.created_at ASC
    `).all(sessionId);

    return transactions;
  }

  /**
   * Get low stock items (below minimum level)
   */
  getLowStockItems() {
    const items = this.db.prepare(`
      SELECT 
        id,
        name,
        category,
        stock_quantity,
        reserved_quantity,
        (stock_quantity - reserved_quantity) as available_quantity,
        min_stock_level,
        unit_price,
        expiry_date
      FROM inventory
      WHERE stock_quantity <= min_stock_level
      ORDER BY stock_quantity ASC
    `).all();

    return items;
  }

  /**
   * Get expired or expiring soon items
   */
  getExpiringItems(daysAhead = 30) {
    const items = this.db.prepare(`
      SELECT 
        id,
        name,
        category,
        stock_quantity,
        expiry_date,
        unit_price
      FROM inventory
      WHERE expiry_date IS NOT NULL
        AND DATE(expiry_date) <= DATE('now', '+' || ? || ' days')
      ORDER BY expiry_date ASC
    `).all(daysAhead);

    return items;
  }

  /**
   * Add stock (purchase/restock)
   */
  addStock(itemId, quantity, notes = 'Stock added') {
    const item = this.getInventoryItem(itemId);
    if (!item) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    // Start transaction
    const add = this.db.transaction((itemId, quantity, notes) => {
      // Update stock
      this.db.prepare(`
        UPDATE inventory
        SET 
          stock_quantity = stock_quantity + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(quantity, itemId);

      // Log the addition
      this.db.prepare(`
        INSERT INTO inventory_transactions (
          inventory_id,
          transaction_type,
          quantity,
          notes
        ) VALUES (?, 'ADD', ?, ?)
      `).run(itemId, quantity, notes);
    });

    add(itemId, quantity, notes);
    
    console.log(`[InventoryManager] Added ${quantity} units to item ${itemId}`);
    
    return this.getInventoryItem(itemId);
  }

  /**
   * Manual adjustment (damage, loss, correction)
   */
  adjustStock(itemId, quantity, notes) {
    const item = this.getInventoryItem(itemId);
    if (!item) {
      throw new Error(`Inventory item ${itemId} not found`);
    }

    // Start transaction
    const adjust = this.db.transaction((itemId, quantity, notes) => {
      // Update stock
      this.db.prepare(`
        UPDATE inventory
        SET 
          stock_quantity = stock_quantity + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(quantity, itemId);

      // Log the adjustment
      this.db.prepare(`
        INSERT INTO inventory_transactions (
          inventory_id,
          transaction_type,
          quantity,
          notes
        ) VALUES (?, 'ADJUST', ?, ?)
      `).run(itemId, quantity, notes);
    });

    adjust(itemId, quantity, notes);
    
    console.log(`[InventoryManager] Adjusted item ${itemId} by ${quantity} units`);
    
    return this.getInventoryItem(itemId);
  }
}

export default InventoryManager;
