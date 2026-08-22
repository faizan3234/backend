/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK — AUTHORITATIVE PRICING SERVICE
 * 
 * GOLDEN RULES:
 * 1. Backend is the SINGLE AUTHORITATIVE source of pricing, tax & platform fee.
 * 2. Frontend amounts are NEVER trusted — frontend only displays breakdowns.
 * 3. Authoritative math:
 *    - subtotalPaise    = sum(itemBasePrice * qty)
 *    - taxPaise         = Math.round(subtotalPaise * (taxRate / 100)) [default 12%]
 *    - platformFeePaise = Math.round(platformFeeRupees * 100) [default ₹2.00]
 *    - totalPaise       = subtotalPaise + taxPaise + platformFeePaise
 * 4. For KIT-BASE-32 (1 qty):
 *    - subtotalPaise    = 3200 (₹32.00)
 *    - taxPaise         = 384  (12% GST = ₹3.84)
 *    - platformFeePaise = 200  (₹2.00)
 *    - totalPaise       = 3784 (₹37.84)
 * 5. FAIL-CLOSED: If kit missing, price invalid, quantity invalid, stock
 *    insufficient, or tax/fee config invalid, THROW immediately.
 * 6. NEVER fallback to hardcoded ₹27, ₹37, ₹48 or frontend cart totals.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { getDb } from '../database/db.js';
import settingsManagerInstance from './settingsManager.js';

export class PricingService {
    constructor({ db = null, settingsManager = settingsManagerInstance } = {}) {
        this._db = db;
        this.settingsManager = settingsManager;
    }

    get db() {
        if (!this._db) {
            this._db = getDb();
        }
        return this._db;
    }

    /**
     * Get authoritative tax rate (e.g. 12 for 12% GST).
     * Fails closed if tax rate setting is present but invalid.
     * 
     * @returns {number}
     */
    getTaxRate() {
        if (this.settingsManager && typeof this.settingsManager.getTaxRate === 'function') {
            const rate = this.settingsManager.getTaxRate();
            if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) {
                const err = new Error('Invalid tax configuration');
                err.code = 'INVALID_TAX_CONFIG';
                throw err;
            }
            return rate;
        }
        return 12; // Default 12% GST standard
    }

    /**
     * Get authoritative platform fee in rupees (e.g. 2 for ₹2.00).
     * Fails closed if platform fee setting is present but invalid.
     * 
     * @returns {number}
     */
    getPlatformFee() {
        if (this.settingsManager && typeof this.settingsManager.getPlatformFee === 'function') {
            const fee = this.settingsManager.getPlatformFee();
            if (fee === null || !Number.isFinite(fee) || fee < 0) {
                const err = new Error('Invalid platform fee configuration');
                err.code = 'INVALID_PLATFORM_FEE_CONFIG';
                throw err;
            }
            return fee;
        }
        return 2; // Default ₹2.00 platform fee
    }

    /**
     * Calculate authoritative total for a medicine cart.
     * 
     * @param {Array<{kit_id: string, quantity: number}>} cart
     * @param {Object} [options]
     * @param {number|null} [options.taxRate] - Optional tax rate override (for testing)
     * @param {number|null} [options.platformFee] - Optional platform fee override (for testing)
     * @returns {{
     *   subtotalPaise: number,
     *   taxPaise: number,
     *   platformFeePaise: number,
     *   totalPaise: number,
     *   subtotalRupees: number,
     *   taxRupees: number,
     *   platformFeeRupees: number,
     *   totalRupees: number,
     *   taxRate: number,
     *   platformFee: number,
     *   items: Array<Object>
     * }}
     */
    calculateAuthoritativeCartTotal(cart, { taxRate = null, platformFee = null } = {}) {
        if (!Array.isArray(cart) || cart.length === 0) {
            const err = new Error('Medicine cart requires at least one item');
            err.code = 'EMPTY_CART';
            throw err;
        }

        const effectiveTaxRate = taxRate !== null ? taxRate : this.getTaxRate();
        if (!Number.isFinite(effectiveTaxRate) || effectiveTaxRate < 0 || effectiveTaxRate > 100) {
            const err = new Error('Invalid tax configuration');
            err.code = 'INVALID_TAX_CONFIG';
            throw err;
        }

        const effectivePlatformFee = platformFee !== null ? platformFee : this.getPlatformFee();
        if (!Number.isFinite(effectivePlatformFee) || effectivePlatformFee < 0) {
            const err = new Error('Invalid platform fee configuration');
            err.code = 'INVALID_PLATFORM_FEE_CONFIG';
            throw err;
        }

        let subtotalPaise = 0;
        let totalTaxPaise = 0;
        const items = [];

        for (const item of cart) {
            if (!item || typeof item !== 'object') {
                const err = new Error('Invalid cart item structure');
                err.code = 'INVALID_CART_ITEM';
                throw err;
            }

            const kitId = String(item.kit_id ?? item.id ?? item.inventory_id ?? '').trim();
            if (!kitId) {
                const err = new Error('Missing kit_id in cart item');
                err.code = 'MISSING_KIT_ID';
                throw err;
            }

            const quantity = Number(item.quantity ?? item.cartQuantity ?? 0);
            if (!Number.isInteger(quantity) || quantity <= 0) {
                const err = new Error(`Invalid quantity for ${kitId}: must be a positive integer`);
                err.code = 'INVALID_QUANTITY';
                throw err;
            }

            const inventoryItem = this.db.prepare(`
                SELECT kit_id, name, price, quantity
                FROM inventory
                WHERE kit_id = ?
            `).get(kitId);

            if (!inventoryItem) {
                const err = new Error(`Medicine ${kitId} not found in inventory`);
                err.code = 'KIT_NOT_FOUND';
                throw err;
            }

            const priceNum = Number(inventoryItem.price);
            if (!Number.isFinite(priceNum) || priceNum < 0) {
                const err = new Error(`Invalid base price for medicine ${kitId}`);
                err.code = 'INVALID_PRICE';
                throw err;
            }

            if (inventoryItem.quantity < quantity) {
                const err = new Error(`Insufficient stock for ${kitId}: have ${inventoryItem.quantity}, need ${quantity}`);
                err.code = 'INSUFFICIENT_STOCK';
                throw err;
            }

            // Authoritative base unit price in paise
            const unitPricePaise = Math.round(priceNum * 100);
            const itemSubtotalPaise = unitPricePaise * quantity;
            const itemTaxPaise = Math.round(itemSubtotalPaise * (effectiveTaxRate / 100));
            const itemTotalPaise = itemSubtotalPaise + itemTaxPaise;

            subtotalPaise += itemSubtotalPaise;
            totalTaxPaise += itemTaxPaise;

            items.push({
                kit_id: kitId,
                name: inventoryItem.name || kitId,
                unitPricePaise,
                unitPriceRupees: unitPricePaise / 100,
                quantity,
                subtotalPaise: itemSubtotalPaise,
                taxPaise: itemTaxPaise,
                totalPaise: itemTotalPaise,
                subtotalRupees: itemSubtotalPaise / 100,
                taxRupees: itemTaxPaise / 100,
                totalRupees: itemTotalPaise / 100
            });
        }

        const platformFeePaise = Math.round(effectivePlatformFee * 100);
        const totalPaise = subtotalPaise + totalTaxPaise + platformFeePaise;

        return {
            subtotalPaise,
            taxPaise: totalTaxPaise,
            platformFeePaise,
            totalPaise,
            subtotalRupees: subtotalPaise / 100,
            taxRupees: totalTaxPaise / 100,
            platformFeeRupees: effectivePlatformFee,
            totalRupees: totalPaise / 100,
            taxRate: effectiveTaxRate,
            platformFee: effectivePlatformFee,
            items
        };
    }

    /**
     * Calculate authoritative price for any service (HEALTH_CHECKUP or MEDICINE)
     * 
     * @param {Object} params
     * @param {string} params.serviceType - 'HEALTH_CHECKUP' | 'MEDICINE'
     * @param {Array} [params.cart] - Required if serviceType is 'MEDICINE'
     * @param {number|null} [params.taxRate] - Optional tax rate override
     * @param {number|null} [params.platformFee] - Optional platform fee override
     * @returns {Object}
     */
    calculateAuthoritativePrice({ serviceType, cart = [], taxRate = null, platformFee = null } = {}) {
        if (serviceType === 'HEALTH_CHECKUP') {
            const configuredPrice = this.settingsManager ? (this.settingsManager.get('health_checkup_price') ?? this.settingsManager.get('healthCheckupPrice')) : null;
            let priceInRupees = configuredPrice !== null ? Number(configuredPrice) : null;
            if (!Number.isFinite(priceInRupees) || priceInRupees <= 0) {
                // Default health checkup service is ₹100.00 (10000 paise)
                priceInRupees = 100;
            }
            const totalPaise = Math.round(priceInRupees * 100);
            return {
                subtotalPaise: totalPaise,
                taxPaise: 0,
                platformFeePaise: 0,
                totalPaise: totalPaise,
                subtotalRupees: totalPaise / 100,
                taxRupees: 0,
                platformFeeRupees: 0,
                totalRupees: totalPaise / 100,
                taxRate: 0,
                platformFee: 0,
                items: [{
                    name: 'Health Checkup Service',
                    quantity: 1,
                    unitPricePaise: totalPaise,
                    unitPriceRupees: totalPaise / 100,
                    subtotalPaise: totalPaise,
                    taxPaise: 0,
                    platformFeePaise: 0,
                    totalPaise: totalPaise,
                    subtotalRupees: totalPaise / 100,
                    taxRupees: 0,
                    totalRupees: totalPaise / 100
                }]
            };
        }

        if (serviceType === 'MEDICINE') {
            return this.calculateAuthoritativeCartTotal(cart, { taxRate, platformFee });
        }

        const err = new Error(`Unknown service type: ${serviceType}`);
        err.code = 'UNKNOWN_SERVICE_TYPE';
        throw err;
    }
}

// Lazy singleton export
let _pricingInstance = null;

function _getPricingInstance() {
    if (!_pricingInstance) {
        _pricingInstance = new PricingService();
    }
    return _pricingInstance;
}

export const pricingService = new Proxy({}, {
    get(_target, prop) {
        const instance = _getPricingInstance();
        const value = instance[prop];
        if (typeof value === 'function') {
            return value.bind(instance);
        }
        return value;
    },
    set(_target, prop, value) {
        const instance = _getPricingInstance();
        instance[prop] = value;
        return true;
    }
});

export default pricingService;
