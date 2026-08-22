import { getDb } from '../database/db.js';

class SettingsManager {
    constructor() {
        this.db = null;
    }

    initialize() {
        this.db = getDb();
        console.log('[SettingsManager] Initialized');
    }

    _ensureDb() {
        if (!this.db) {
            this.initialize();
        }
        if (!this.db) {
            throw new Error('SettingsManager not initialized');
        }
    }

    get(key, defaultValue = null) {
        this._ensureDb();
        const row = this.db.prepare(`
            SELECT value FROM settings WHERE key = ?
        `).get(key);

        return row ? row.value : defaultValue;
    }

    set(key, value) {
        this._ensureDb();
        this.db.prepare(`
            INSERT INTO settings (key, value, updatedAt)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updatedAt = CURRENT_TIMESTAMP
        `).run(key, String(value));

        return this.get(key);
    }

    getReportPrice() {
        const rawValue = this.get('reportPrice', '27');
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) ? parsed : 27;
    }

    getTaxRate() {
        const rawValue = this.get('taxRate') ?? this.get('tax_rate') ?? this.get('gstRate') ?? this.get('gst_rate') ?? '12';
        const parsed = Number(String(rawValue).replace('%', '').trim());
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
            return null; // Invalid tax configuration -> triggers fail-closed!
        }
        return parsed;
    }

    setTaxRate(rate) {
        const num = Number(rate);
        if (!Number.isFinite(num) || num < 0 || num > 100) {
            throw new Error('Invalid tax rate: must be between 0 and 100');
        }
        this.set('tax_rate', num);
        return num;
    }

    getPlatformFee() {
        const rawValue = this.get('platformFee') ?? this.get('platform_fee') ?? this.get('convenienceFee') ?? this.get('convenience_fee') ?? '2';
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return null; // Invalid platform fee configuration -> triggers fail-closed!
        }
        return parsed;
    }

    setPlatformFee(fee) {
        const num = Number(fee);
        if (!Number.isFinite(num) || num < 0) {
            throw new Error('Invalid platform fee: must be a non-negative number');
        }
        this.set('platform_fee', num);
        return num;
    }
}

export default new SettingsManager();

