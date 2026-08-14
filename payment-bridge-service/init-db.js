import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = './bridge.db';

console.log('🔧 Initializing Payment Bridge database...\n');

// Create database
const db = new Database(DB_PATH);

// Create authorizations table
db.exec(`
  CREATE TABLE IF NOT EXISTS authorizations (
    auth_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    kiosk_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    authorization_json TEXT NOT NULL,
    signature TEXT NOT NULL,
    delivered BOOLEAN DEFAULT 0,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    INDEX idx_session (session_id),
    INDEX idx_transaction (transaction_id),
    INDEX idx_kiosk_delivered (kiosk_id, delivered),
    INDEX idx_created (created_at),
    INDEX idx_expires (expires_at)
  );
`);

console.log('✅ Created table: authorizations');

// Create authoritative orders table
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    kiosk_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'CREATED',
    created_at INTEGER NOT NULL,
    INDEX idx_order_session (session_id),
    INDEX idx_order_transaction (transaction_id)
  );
`);

console.log('✅ Created table: orders');

// Create cleanup trigger for expired authorizations
db.exec(`
  CREATE TRIGGER IF NOT EXISTS cleanup_expired_authorizations
  AFTER INSERT ON authorizations
  BEGIN
    DELETE FROM authorizations
    WHERE expires_at < (strftime('%s', 'now') * 1000)
      AND created_at < (strftime('%s', 'now') * 1000) - 86400000; -- older than 24h
  END;
`);

console.log('✅ Created trigger: cleanup_expired_authorizations');

// Create verification log table (optional but useful for audit)
db.exec(`
  CREATE TABLE IF NOT EXISTS verification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT NOT NULL,
    session_id TEXT,
    transaction_id TEXT,
    amount INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    INDEX idx_payment (payment_id),
    INDEX idx_created (created_at)
  );
`);

console.log('✅ Created table: verification_log');

db.close();

console.log('\n✅ Payment Bridge database initialized successfully');
console.log(`   Database path: ${path.resolve(DB_PATH)}`);
