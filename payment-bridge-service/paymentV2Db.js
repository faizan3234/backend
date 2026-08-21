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
        CREATE INDEX IF NOT EXISTS idx_v2_orders_status ON payment_v2_orders(status);
    `);
}

export default {
    initPaymentV2Schema
};
