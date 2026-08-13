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

    setReportPrice(price) {
        return Number(this.set('reportPrice', price));
    }
}

export default new SettingsManager();
