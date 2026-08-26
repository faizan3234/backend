/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE - PAYMENT V2 DATABASE HELPER
 * Purpose: Schema setup and query helpers for payment_v2_orders
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Ensure Payment V2 database tables and indexes exist
 * @param {import('better-sqlite3').Database} db
 */
export function initPaymentV2Schema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS payment_v2_orders (
            order_id TEXT PRIMARY KEY,
            request_id TEXT UNIQUE NOT NULL,
            request_nonce TEXT UNIQUE NOT NULL,
            payload_fingerprint TEXT NOT NULL,
            session_id TEXT NOT NULL,
            transaction_id TEXT NOT NULL,
            kiosk_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            currency TEXT NOT NULL DEFAULT 'INR',
            service_type TEXT NOT NULL,
            encrypted_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'CREATED',
            razorpay_payment_id TEXT,
            item_name TEXT,
            cart TEXT,
            customer_name TEXT,
            items_json TEXT,
            breakdown_json TEXT,
            encrypted_health_snapshot TEXT,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            verified_at INTEGER,
            CHECK (status IN ('CREATED', 'PAID', 'FAILED', 'EXPIRED'))
        );

        CREATE INDEX IF NOT EXISTS idx_v2_orders_request ON payment_v2_orders(request_id);
        CREATE INDEX IF NOT EXISTS idx_v2_orders_session ON payment_v2_orders(session_id);
        CREATE INDEX IF NOT EXISTS idx_v2_orders_nonce ON payment_v2_orders(request_nonce);
        CREATE INDEX IF NOT EXISTS idx_v2_orders_fingerprint ON payment_v2_orders(payload_fingerprint);
        CREATE INDEX IF NOT EXISTS idx_v2_orders_status ON payment_v2_orders(status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_orders_rzp_payment ON payment_v2_orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS payment_v2_receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT NOT NULL,
            email TEXT NOT NULL,
            status TEXT NOT NULL,
            message_id TEXT,
            created_at INTEGER NOT NULL,
            sent_at INTEGER,
            last_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_payment_v2_receipts_request
        ON payment_v2_receipts(request_id);

        CREATE TABLE IF NOT EXISTS payment_v2_health_scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT UNIQUE NOT NULL,
            order_id TEXT NOT NULL,
            transaction_id TEXT NOT NULL,
            email_key TEXT NOT NULL,
            encrypted_email TEXT NOT NULL,
            scan_number INTEGER NOT NULL,
            encrypted_snapshot TEXT NOT NULL,
            delivery_status TEXT NOT NULL DEFAULT 'PENDING',
            message_id TEXT,
            sent_at INTEGER,
            last_error TEXT,
            download_token_hash TEXT,
            download_token_expires_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(email_key, scan_number),
            CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED'))
        );

        CREATE INDEX IF NOT EXISTS idx_v2_health_scans_email
        ON payment_v2_health_scans(email_key, scan_number);

        CREATE INDEX IF NOT EXISTS idx_v2_health_scans_request
        ON payment_v2_health_scans(request_id);

        CREATE INDEX IF NOT EXISTS idx_v2_health_scans_delivery
        ON payment_v2_health_scans(delivery_status);
    `);

    // Migration helper: safely add columns if table was created in an earlier schema version
    try {
        const cols = db.prepare("PRAGMA table_info(payment_v2_orders)").all();
        const colNames = new Set(cols.map(c => c.name));
        if (!colNames.has('payload_fingerprint')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN payload_fingerprint TEXT DEFAULT '';");
            db.exec("CREATE INDEX IF NOT EXISTS idx_v2_orders_fingerprint ON payment_v2_orders(payload_fingerprint);");
        }
        if (!colNames.has('item_name')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN item_name TEXT;");
        }
        if (!colNames.has('cart')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN cart TEXT;");
        }
        if (!colNames.has('customer_name')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN customer_name TEXT;");
        }
        if (!colNames.has('items_json')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN items_json TEXT;");
        }
        if (!colNames.has('breakdown_json')) {
            db.exec("ALTER TABLE payment_v2_orders ADD COLUMN breakdown_json TEXT;");
        }
        if (!colNames.has('encrypted_health_snapshot')) {
            db.exec(
                "ALTER TABLE payment_v2_orders ADD COLUMN encrypted_health_snapshot TEXT;"
            );
        }
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_orders_rzp_payment ON payment_v2_orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;");
    } catch (e) {}
}

export default {
    initPaymentV2Schema
};
