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
    `);

    // Migration helper: add columns if table was created in an earlier schema version
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
        db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_orders_rzp_payment ON payment_v2_orders(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;");
    } catch (e) {}
}

export default {
    initPaymentV2Schema
};
