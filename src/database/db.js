/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK - LOCAL DATABASE MODULE
 * Purpose: SQLite database connection and initialization for offline-first operation
 * ═══════════════════════════════════════════════════════════════════════════
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ───────────────────────────────────────────────────────────────────────────
// Database Configuration
// ───────────────────────────────────────────────────────────────────────────
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let db = null;
let currentDbPath = null;

export function getDatabasePath() {
    return currentDbPath || process.env.DB_PATH || join(process.cwd(), 'data', 'kiosk.db');
}

/**
 * Initialize the SQLite database
 * - Creates database file if it doesn't exist
 * - Runs schema migrations
 * - Enables WAL mode for better concurrency
 * - Sets up foreign key constraints
 * 
 * @param {string|null} [customPath] - Optional custom database file path (e.g. for isolated test suites)
 */
export function initializeDatabase(customPath = null) {
    try {
        const targetPath = customPath || process.env.DB_PATH || join(process.cwd(), 'data', 'kiosk.db');
        
        // If a different database is already open, close it cleanly first
        if (db && currentDbPath !== targetPath) {
            try { db.close(); } catch {}
            db = null;
        }

        if (db) {
            return db;
        }

        console.log(`[DB] Initializing database at: ${targetPath}`);
        currentDbPath = targetPath;
        
        // Open database connection
        db = new Database(targetPath, {
            verbose: process.env.NODE_ENV === 'development' ? console.log : null
        });
        
        // Enable WAL mode for better concurrency and crash recovery
        db.pragma('journal_mode = WAL');
        
        // Enable foreign key constraints
        db.pragma('foreign_keys = ON');

        
        // Set reasonable cache size (2MB)
        db.pragma('cache_size = -2000');
        
        // Migration helper: ensure pairing columns exist in sessions table if database was created prior
        try { db.exec("ALTER TABLE sessions ADD COLUMN pairing_token TEXT;"); } catch (e) {}
        try { db.exec("ALTER TABLE sessions ADD COLUMN pairing_used INTEGER DEFAULT 0;"); } catch (e) {}

        // Migration helper: ensure motor_id and unique index exist in fulfillment_jobs table
        try { db.exec("ALTER TABLE fulfillment_jobs ADD COLUMN motor_id INTEGER;"); } catch (e) {}
        try {
            // Deduplicate any legacy duplicate rows before applying unique index
            db.exec(`
                DELETE FROM fulfillment_jobs
                WHERE rowid NOT IN (
                    SELECT MIN(rowid)
                    FROM fulfillment_jobs
                    GROUP BY transaction_id, kit_id
                );
            `);
            db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_jobs_txn_kit ON fulfillment_jobs(transaction_id, kit_id);");
        } catch (e) {}

        // Migration helper: ensure event_queue check constraint allows EMAIL_REPORT & EMAIL_RECEIPT
        try {
            const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='event_queue'").get();
            if (tableSql && tableSql.sql && !tableSql.sql.includes('EMAIL_REPORT')) {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS event_queue_new (
                        event_id TEXT PRIMARY KEY,
                        type TEXT NOT NULL,
                        session_id TEXT,
                        payload TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'PENDING',
                        attempts INTEGER DEFAULT 0,
                        max_attempts INTEGER DEFAULT 3,
                        created_at TEXT NOT NULL DEFAULT (datetime('now')),
                        next_attempt_at TEXT,
                        processed_at TEXT,
                        last_error TEXT,
                        CHECK (type IN ('EMAIL_REPORT', 'EMAIL_RECEIPT', 'EMAIL_PENDING', 'SYNC_PENDING', 'REPORT_CREATED', 'RECEIPT_CREATED', 'PAYMENT_VERIFIED', 'DISPENSE_STARTED', 'DISPENSE_COMPLETED')),
                        CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
                    );
                    INSERT INTO event_queue_new SELECT * FROM event_queue;
                    DROP TABLE event_queue;
                    ALTER TABLE event_queue_new RENAME TO event_queue;
                    CREATE INDEX IF NOT EXISTS idx_event_queue_type ON event_queue(type);
                    CREATE INDEX IF NOT EXISTS idx_event_queue_status ON event_queue(status);
                    CREATE INDEX IF NOT EXISTS idx_event_queue_next_attempt ON event_queue(next_attempt_at);
                `);
            }
        } catch (e) {}

        // Migration helper: ensure payment_v2_requests table exists
        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS payment_v2_requests (
                    request_id TEXT PRIMARY KEY,
                    request_nonce TEXT UNIQUE NOT NULL,
                    session_id TEXT NOT NULL,
                    transaction_id TEXT NOT NULL,
                    kiosk_id TEXT NOT NULL,
                    amount INTEGER NOT NULL,
                    service_type TEXT NOT NULL,
                    code_hmac TEXT NOT NULL,
                    encrypted_package TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE',
                    attempt_count INTEGER DEFAULT 0,
                    max_attempts INTEGER DEFAULT 5,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    verified_at INTEGER,
                    consumed_at INTEGER,
                    cancelled_at INTEGER,
                    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
                    CHECK (status IN ('ACTIVE', 'VERIFIED', 'EXPIRED', 'LOCKED', 'CANCELLED'))
                );
                CREATE INDEX IF NOT EXISTS idx_payment_v2_session ON payment_v2_requests(session_id);
                CREATE INDEX IF NOT EXISTS idx_payment_v2_transaction ON payment_v2_requests(transaction_id);
                CREATE INDEX IF NOT EXISTS idx_payment_v2_nonce ON payment_v2_requests(request_nonce);
                CREATE INDEX IF NOT EXISTS idx_payment_v2_status ON payment_v2_requests(status);
                CREATE INDEX IF NOT EXISTS idx_payment_v2_expires ON payment_v2_requests(expires_at);
            `);
        } catch (e) {}

        // Run schema initialization
        const schema = readFileSync(SCHEMA_PATH, 'utf-8');
        db.exec(schema);

        // ─────────────────────────────────────────────────────────────────────────────
        // MIGRATION: medicine local image support
        // Existing kiosks created before medicine images do not have image_path.
        // Safe to run on every startup.
        // ─────────────────────────────────────────────────────────────────────────────
        try {
            const inventoryColumns = db
                .prepare(`PRAGMA table_info(inventory)`)
                .all();

            const hasImagePath = inventoryColumns.some(
                (column) => column.name === "image_path"
            );

            if (!hasImagePath) {
                console.log(
                    "[Database] Adding image_path column to inventory..."
                );

                db.exec(`
                    ALTER TABLE inventory
                    ADD COLUMN image_path TEXT NOT NULL DEFAULT '';
                `);

                console.log(
                    "[Database] ✅ inventory.image_path migration complete"
                );
            }
        } catch (err) {
            console.error(
                "[Database] ❌ inventory image_path migration failed:",
                err.message
            );

            throw err;
        }
        
        // Verify schema version
        const versionRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
        const currentVersion = versionRow ? versionRow.version : 0;
        
        console.log(`[DB] ✅ Database initialized successfully (schema v${currentVersion})`);
        console.log(`[DB] SQLite version: ${db.pragma('user_version', { simple: true })}`);
        
        // Return database instance
        return db;
        
    } catch (err) {
        console.error('[DB] ❌ Failed to initialize database:', err);
        throw err;
    }
}

/**
 * Get the database instance
 * @returns {Database} SQLite database instance
 */
export function getDb() {
    if (!db) {
        throw new Error('Database not initialized. Call initializeDatabase() first.');
    }
    return db;
}

/**
 * Close the database connection
 */
export function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        currentDbPath = null;
        console.log('[DB] Database connection closed');
    }
}

/**
 * Run database health check
 * @returns {Object} Health status
 */
export function checkDatabaseHealth() {
    try {
        if (!db) {
            return { ok: false, healthy: false, error: 'Database not initialized', message: 'Database not initialized' };
        }
        
        // Test basic query
        const result = db.prepare('SELECT 1 as test').get();
        
        // Check WAL mode
        const walMode = db.pragma('journal_mode', { simple: true });
        
        // Get database stats
        const stats = db.prepare(`
            SELECT 
                (SELECT COUNT(*) FROM sessions) as total_sessions,
                (SELECT COUNT(*) FROM transactions) as total_transactions,
                (SELECT COUNT(*) FROM inventory) as total_inventory
        `).get();
        
        return {
            ok: true,
            healthy: true,
            message: 'Database healthy',
            walMode,
            stats
        };
        
    } catch (err) {
        return {
            ok: false,
            healthy: false,
            error: err.message,
            message: err.message
        };
    }
}

/**
 * Execute a transaction with automatic rollback on error
 * @param {Function} callback - Function to execute within transaction
 * @returns {*} Result from callback
 */
export function transaction(callback) {
    const db = getDb();
    const txn = db.transaction(callback);
    return txn();
}

// ───────────────────────────────────────────────────────────────────────────
// Graceful shutdown handler
// ───────────────────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', () => {
    closeDatabase();
    process.exit(0);
});

export default {
    initializeDatabase,
    getDb,
    closeDatabase,
    checkDatabaseHealth,
    transaction
};
