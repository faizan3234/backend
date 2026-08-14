-- ═══════════════════════════════════════════════════════════════════════════
-- RELIV KIOSK - LOCAL SQLITE DATABASE SCHEMA
-- Purpose: Offline-first local persistence for kiosk operations
-- ═══════════════════════════════════════════════════════════════════════════

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ───────────────────────────────────────────────────────────────────────────
-- SESSIONS - Core customer interaction tracking
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    kiosk_id TEXT NOT NULL DEFAULT 'RELIV-001',
    
    -- State machine status
    status TEXT NOT NULL DEFAULT 'CREATED', 
    -- States: CREATED, CUSTOMER_ATTACHED, SERVICE_SELECTED, MEASUREMENTS_COMPLETE,
    --         PAYMENT_REQUIRED, PAYMENT_PENDING, PAYMENT_VERIFIED, FULFILLMENT, COMPLETED
    
    -- Customer information (JSON)
    customer_data TEXT,
    
    -- Service details
    service_type TEXT, -- 'HEALTH_CHECKUP' or 'MEDICINE'
    
    -- Financial
    amount REAL DEFAULT 0,
    payment_status TEXT DEFAULT 'NOT_REQUIRED', -- NOT_REQUIRED, PENDING, VERIFIED, FAILED
    payment_id TEXT,
    
    -- Fulfillment tracking
    dispense_status TEXT DEFAULT 'NOT_REQUIRED', -- NOT_REQUIRED, PENDING, IN_PROGRESS, COMPLETED, FAILED
    report_status TEXT DEFAULT 'NOT_REQUIRED', -- NOT_REQUIRED, GENERATING, READY, EMAILED
    receipt_status TEXT DEFAULT 'NOT_REQUIRED', -- NOT_REQUIRED, GENERATING, READY, EMAILED
    
    -- QR session tracking
    qr_token TEXT UNIQUE,
    qr_path TEXT UNIQUE,
    qr_used INTEGER DEFAULT 0,
    pairing_token TEXT UNIQUE, -- ONE-QR: Single-use pairing token for payment completion
    pairing_used INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Cloud sync
    synced_to_mongo INTEGER DEFAULT 0,
    
    CHECK (status IN ('CREATED', 'CUSTOMER_ATTACHED', 'SERVICE_SELECTED', 'MEASUREMENTS_COMPLETE', 
                      'PAYMENT_REQUIRED', 'PAYMENT_PENDING', 'PAYMENT_VERIFIED', 'FULFILLMENT', 'COMPLETED')),
    CHECK (payment_status IN ('NOT_REQUIRED', 'PENDING', 'VERIFIED', 'FAILED')),
    CHECK (service_type IN ('HEALTH_CHECKUP', 'MEDICINE', NULL))
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_qr_token ON sessions(qr_token);
CREATE INDEX IF NOT EXISTS idx_sessions_qr_path ON sessions(qr_path);
CREATE INDEX IF NOT EXISTS idx_sessions_pairing_token ON sessions(pairing_token);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_synced ON sessions(synced_to_mongo);

-- ───────────────────────────────────────────────────────────────────────────
-- TRANSACTIONS - Financial transaction tracking
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    
    -- Transaction details
    type TEXT NOT NULL, -- 'HEALTH_CHECKUP' or 'MEDICINE'
    amount REAL NOT NULL, -- Authoritative amount calculated by backend
    cart TEXT, -- JSON array for medicine purchases
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, VERIFIED, FULFILLED, FAILED
    
    -- Payment provider details
    provider TEXT DEFAULT 'RAZORPAY',
    provider_order_id TEXT,
    provider_payment_id TEXT,
    
    -- Verification flags
    verified INTEGER DEFAULT 0,
    verified_at TEXT,
    fulfilled INTEGER DEFAULT 0,
    fulfilled_at TEXT,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Cloud sync
    synced_to_mongo INTEGER DEFAULT 0,
    
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    CHECK (type IN ('HEALTH_CHECKUP', 'MEDICINE')),
    CHECK (status IN ('PENDING', 'VERIFIED', 'FULFILLED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_session ON transactions(session_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_provider_order ON transactions(provider_order_id);
CREATE INDEX IF NOT EXISTS idx_transactions_provider_payment ON transactions(provider_payment_id);
CREATE INDEX IF NOT EXISTS idx_transactions_synced ON transactions(synced_to_mongo);

-- ───────────────────────────────────────────────────────────────────────────
-- INVENTORY - Local medicine inventory management
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory (
    kit_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price REAL NOT NULL, -- Authoritative price - backend calculates from this
    quantity INTEGER NOT NULL DEFAULT 0,
    motor_id INTEGER,
    description TEXT,
    
    -- Tracking
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_to_mongo INTEGER DEFAULT 0,
    
    CHECK (price >= 0),
    CHECK (quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_inventory_motor ON inventory(motor_id);

-- ───────────────────────────────────────────────────────────────────────────
-- INVENTORY_RESERVATIONS - Prevent double-dispensing
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_reservations (
    reservation_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'RESERVED', -- RESERVED, COMMITTED, ROLLED_BACK
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
    FOREIGN KEY (kit_id) REFERENCES inventory(kit_id),
    CHECK (status IN ('RESERVED', 'COMMITTED', 'ROLLED_BACK'))
);

CREATE INDEX IF NOT EXISTS idx_reservations_transaction ON inventory_reservations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON inventory_reservations(status);

-- ───────────────────────────────────────────────────────────────────────────
-- DISPENSE_JOBS - Medicine dispensing job tracking
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dispense_jobs (
    job_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    
    -- Commands sent to ESP32 (JSON)
    commands TEXT NOT NULL,
    
    -- Status tracking
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, IN_PROGRESS, COMPLETED, FAILED
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    
    -- Error tracking
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_dispense_jobs_transaction ON dispense_jobs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_dispense_jobs_status ON dispense_jobs(status);

-- ───────────────────────────────────────────────────────────────────────────
-- REPORTS - Health report tracking and storage
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    
    -- Customer and measurement data (JSON)
    customer_data TEXT NOT NULL,
    measurements TEXT NOT NULL,
    
    -- File storage
    pdf_path TEXT NOT NULL,
    pdf_size INTEGER,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'GENERATED', -- GENERATED, EMAILED, EMAIL_FAILED
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    emailed_at TEXT,
    
    -- Cloud sync
    synced_to_mongo INTEGER DEFAULT 0,
    
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    CHECK (status IN ('GENERATED', 'EMAILED', 'EMAIL_FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_reports_session ON reports(session_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- ───────────────────────────────────────────────────────────────────────────
-- RECEIPTS - Medicine purchase receipt tracking and storage
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    
    -- Purchase details (JSON)
    cart TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_ref TEXT,
    
    -- File storage
    pdf_path TEXT NOT NULL,
    pdf_size INTEGER,
    
    -- Status
    status TEXT NOT NULL DEFAULT 'GENERATED', -- GENERATED, EMAILED, EMAIL_FAILED
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    emailed_at TEXT,
    
    -- Cloud sync
    synced_to_mongo INTEGER DEFAULT 0,
    
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    CHECK (status IN ('GENERATED', 'EMAILED', 'EMAIL_FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_receipts_transaction ON receipts(transaction_id);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON receipts(session_id);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('reportPrice', '27');

-- ───────────────────────────────────────────────────────────────────────────
-- PAYMENT_NONCES - Replay attack prevention for payment authorizations
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_nonces (
    nonce TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_nonces_session ON payment_nonces(session_id);
CREATE INDEX IF NOT EXISTS idx_payment_nonces_transaction ON payment_nonces(transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_nonces_used_at ON payment_nonces(used_at);

-- ───────────────────────────────────────────────────────────────────────────
-- FULFILLMENT_JOBS - Dispensing state machine with restart recovery
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fulfillment_jobs (
    job_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    
    -- State machine: PENDING → IN_PROGRESS → COMPLETED / FAILED
    state TEXT NOT NULL DEFAULT 'PENDING',
    
    -- MQTT integration
    mqtt_topic TEXT,
    mqtt_payload TEXT,
    mqtt_published_at TEXT,
    esp32_ack_received_at TEXT,
    esp32_ack_payload TEXT,
    
    -- Retry/recovery
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    
    -- Error tracking
    error_message TEXT,
    
    FOREIGN KEY (session_id) REFERENCES sessions(session_id),
    FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
    FOREIGN KEY (kit_id) REFERENCES kits(kit_id),
    
    CHECK (state IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW_REQUIRED')),
    CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_state ON fulfillment_jobs(state);
CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_session ON fulfillment_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_transaction ON fulfillment_jobs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_jobs_created ON fulfillment_jobs(created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- EVENT_QUEUE - Background tasks (email, sync, etc.)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_queue (
    event_id TEXT PRIMARY KEY,
    
    -- Event classification
    type TEXT NOT NULL, -- EMAIL_PENDING, SYNC_PENDING, REPORT_CREATED, RECEIPT_CREATED, etc.
    session_id TEXT,
    
    -- Event payload (JSON)
    payload TEXT NOT NULL,
    
    -- Processing status
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, PROCESSING, COMPLETED, FAILED
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT,
    processed_at TEXT,
    
    -- Error tracking
    last_error TEXT,
    
    CHECK (type IN ('EMAIL_PENDING', 'SYNC_PENDING', 'REPORT_CREATED', 'RECEIPT_CREATED', 
                    'PAYMENT_VERIFIED', 'DISPENSE_STARTED', 'DISPENSE_COMPLETED')),
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_event_queue_type ON event_queue(type);
CREATE INDEX IF NOT EXISTS idx_event_queue_status ON event_queue(status);
CREATE INDEX IF NOT EXISTS idx_event_queue_next_attempt ON event_queue(next_attempt_at);

-- ───────────────────────────────────────────────────────────────────────────
-- AUDIT_LOG - System event logging for debugging and recovery
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Event details
    event_type TEXT NOT NULL,
    session_id TEXT,
    transaction_id TEXT,
    
    -- Details (JSON)
    details TEXT,
    
    -- Result
    success INTEGER NOT NULL DEFAULT 1,
    error_message TEXT,
    
    -- Timestamp
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_transaction ON audit_log(transaction_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- SYSTEM_CONFIG - System-wide configuration and state
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Initialize default config
INSERT OR IGNORE INTO system_config (key, value) VALUES 
    ('kiosk_id', 'RELIV-001'),
    ('report_price', '27'),
    ('session_ttl_minutes', '10'),
    ('db_initialized_at', datetime('now'));

-- Initialize schema version
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
