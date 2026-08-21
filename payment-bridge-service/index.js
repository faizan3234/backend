import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import Razorpay from 'razorpay';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import PaymentV2CloudService from './paymentV2Service.js';
import { createPaymentV2Router } from './paymentV2Routes.js';

dotenv.config();

const app = express();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 10000);
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || './private-key.pem';
const DATABASE_PATH = process.env.DATABASE_PATH || './bridge.db';

const allowedOrigins = String(
    process.env.ALLOWED_ORIGINS || ''
)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn(
        '⚠️ ALLOWED_ORIGINS is empty. Browser requests will be rejected.'
    );
}

/**
 * Reverse proxy is expected to run on the same machine.
 * Trust only loopback proxy addresses.
 */
app.set('trust proxy', 'loopback');

/**
 * Do not expose Express implementation details.
 */
app.disable('x-powered-by');

/**
 * Explicit browser CORS policy.
 *
 * Requests without Origin are allowed because:
 * - health checks
 * - server-to-server requests
 * - curl diagnostics
 *
 * Browser Origins must be explicitly whitelisted.
 */
app.use(
    cors({
        origin(origin, callback) {
            if (!origin) {
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            console.warn(`🚫 Blocked CORS origin: ${origin}`);

            return callback(null, false);
        },

        methods: ['GET', 'POST', 'OPTIONS'],

        allowedHeaders: [
            'Content-Type',
            'Authorization'
        ],

        credentials: false
    })
);

/**
 * Payment payloads are small.
 * Do not permit arbitrarily large request bodies.
 */
app.use(express.json({ limit: '256kb' }));
app.use(
    express.urlencoded({
        extended: true,
        limit: '256kb'
    })
);

/**
 * ============================================================
 * REQUIRED CLOUD CONFIGURATION
 * ============================================================
 */

const requiredEnvVars = [
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'ALLOWED_ORIGINS'
];

const missingEnvVars = requiredEnvVars.filter(
    name => !process.env[name] || !String(process.env[name]).trim()
);

if (missingEnvVars.length > 0) {
    console.error(
        `❌ Missing required environment variables: ${missingEnvVars.join(', ')}`
    );

    process.exit(1);
}

// ============================================================
// RSA PRIVATE KEY
// ============================================================

let privateKey;

try {
    privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');

    if (!privateKey.includes('PRIVATE KEY')) {
        throw new Error('File does not contain a valid PEM private key');
    }

    console.log(
        `✅ Payment authorization private key loaded from ${PRIVATE_KEY_PATH}`
    );
} catch (error) {
    console.error(
        `❌ CRITICAL: Unable to load payment private key from ${PRIVATE_KEY_PATH}`
    );

    console.error(error.message);

    process.exit(1);
}

// ============================================================
// PAYMENT BRIDGE DATABASE
// ============================================================

let db;

try {
    db = new Database(DATABASE_PATH);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    console.log(
        `✅ Payment Bridge database opened: ${DATABASE_PATH}`
    );

    // Ensure orders table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        kiosk_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        status TEXT NOT NULL DEFAULT 'CREATED',
        created_at INTEGER NOT NULL
      );
    `);

    // Ensure authorizations table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS authorizations (
        auth_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        kiosk_id TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL DEFAULT 'INR',
        authorization_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);

    // Ensure verification_log table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS verification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id TEXT,
        session_id TEXT,
        transaction_id TEXT,
        amount INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);

} catch (error) {
    console.error(
        `❌ CRITICAL: Could not initialize Payment Bridge database at ${DATABASE_PATH}`
    );

    console.error(error);

    process.exit(1);
}

// ============================================================
// RAZORPAY CLIENT
// ============================================================

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

console.log('✅ Razorpay client initialized');

// ============================================================
// PAYMENT V2 CLOUD SERVICE (Zero-Internet Kiosk QR Protocol)
// ============================================================

const paymentV2Service = new PaymentV2CloudService({
    db,
    razorpay,
    cloudPrivateKeyPath: process.env.PAYMENT_V2_CLOUD_PRIVATE_KEY_PATH || './payment-v2-cloud-private-key.pem',
    kioskPublicKeyPath: process.env.PAYMENT_V2_KIOSK_PUBLIC_KEY_PATH || './payment-v2-kiosk-public-key.pem',
    codeSecret: process.env.PAYMENT_V2_CODE_ENCRYPTION_SECRET
});

app.use('/v2', createPaymentV2Router(paymentV2Service));
app.use('/api/v2', createPaymentV2Router(paymentV2Service));

console.log('✅ Payment V2 cloud routes mounted on /v2 and /api/v2');

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITATIVE ORDER CREATION & BINDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /create-order
 * 
 * Customer HTTPS website calls this to create an authoritative Razorpay order
 * bound to specific sessionId, transactionId, kioskId, and amount.
 */
app.post('/create-order', async (req, res) => {
  try {
    const {
      sessionId,
      transactionId,
      kioskId = 'KIOSK-001',
      amount,
      currency = 'INR'
    } = req.body;

    if (!sessionId || !transactionId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: sessionId, transactionId, and amount are required'
      });
    }

    // 1. Create order on Razorpay API with embedded notes
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(amount), // paise
      currency,
      receipt: transactionId,
      notes: {
        sessionId,
        transactionId,
        kioskId
      }
    });

    // 2. Persist authoritative binding in Payment Bridge SQLite database
    const stmt = db.prepare(`
      INSERT INTO orders (order_id, session_id, transaction_id, kiosk_id, amount, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'CREATED', ?)
    `);
    stmt.run(razorpayOrder.id, sessionId, transactionId, kioskId, Math.round(amount), currency, Date.now());

    console.log(`✅ Authoritative order created: ${razorpayOrder.id}`);
    console.log(`   Session: ${sessionId}, Transaction: ${transactionId}, Amount: ₹${amount / 100}`);

    res.json({
      success: true,
      order: razorpayOrder
    });

  } catch (error) {
    console.error('❌ Failed to create Razorpay order:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Razorpay order'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT AUTHORIZATION STORAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store authorization in database
 */
function storeAuthorization(kioskId, authorization, signature) {
  const authId = crypto.randomBytes(16).toString('hex');
  
  const stmt = db.prepare(`
    INSERT INTO authorizations (
      auth_id,
      session_id,
      transaction_id,
      kiosk_id,
      payment_id,
      order_id,
      amount,
      currency,
      authorization_json,
      signature,
      created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    authId,
    authorization.sessionId,
    authorization.transactionId,
    kioskId,
    authorization.paymentId,
    authorization.orderId,
    authorization.amount,
    authorization.currency,
    JSON.stringify(authorization),
    signature,
    authorization.issuedAt,
    authorization.expiresAt
  );
  
  console.log(`✅ Authorization persisted: ${authId}`);
  console.log(`   Kiosk: ${kioskId}, Session: ${authorization.sessionId}`);
  
  return authId;
}

/**
 * Log verification attempt
 */
function logVerification(paymentId, sessionId, transactionId, amount, status, error = null) {
  const stmt = db.prepare(`
    INSERT INTO verification_log (payment_id, session_id, transaction_id, amount, status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(paymentId, sessionId, transactionId, amount, status, error, Date.now());
}

/**
 * Generate cryptographically random nonce
 */
function generateNonce() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Sign payment authorization with private key
 * Returns base64-encoded signature
 */
function signAuthorization(payload) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(JSON.stringify(payload));
  sign.end();
  return sign.sign(privateKey, 'base64');
}

/**
 * POST /verify-payment
 * 
 * Customer phone calls this after Razorpay payment
 * 
 * Request body:
 * {
 *   razorpay_payment_id: string,
 *   razorpay_order_id: string,
 *   razorpay_signature: string,
 *   sessionId: string,
 *   transactionId: string,
 *   kioskId: string (optional, default "KIOSK-001")
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   authorization: {
 *     sessionId,
 *     transactionId,
 *     kioskId,
 *     amount,
 *     currency,
 *     paymentId,
 *     orderId,
 *     issuedAt,
 *     expiresAt,
 *     nonce,
 *     version: "1.0"
 *   },
 *   signature: "base64-encoded-signature"
 * }
 */
app.post('/verify-payment', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      sessionId,
      transactionId,
      kioskId = 'KIOSK-001'
    } = req.body;

    // Validation
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      logVerification(razorpay_payment_id, sessionId, transactionId, null, 'FAILED', 'Missing Razorpay parameters');
      return res.status(400).json({
        success: false,
        error: 'Missing required Razorpay parameters'
      });
    }

    if (!sessionId || !transactionId) {
      logVerification(razorpay_payment_id, sessionId, transactionId, null, 'FAILED', 'Missing session/transaction');
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId or transactionId'
      });
    }

    // Step 1: Verify Razorpay signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.warn(`❌ Invalid Razorpay signature for payment ${razorpay_payment_id}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, null, 'FAILED', 'Invalid signature');
      return res.status(400).json({
        success: false,
        error: 'Invalid Razorpay signature'
      });
    }

    console.log(`✅ Razorpay signature verified: ${razorpay_payment_id}`);

    // Step 2: Fetch payment details from Razorpay API
    let payment;
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id);
    } catch (error) {
      console.error(`❌ Failed to fetch payment from Razorpay:`, error.message);
      logVerification(razorpay_payment_id, sessionId, transactionId, null, 'FAILED', 'Razorpay API error');
      return res.status(500).json({
        success: false,
        error: 'Failed to verify payment with Razorpay'
      });
    }

    // Step 3: Verify payment status
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      console.warn(`❌ Payment not captured: ${razorpay_payment_id} (status: ${payment.status})`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', `Status: ${payment.status}`);
      return res.status(400).json({
        success: false,
        error: `Payment not successful (status: ${payment.status})`
      });
    }

    // Step 4: Verify order ID matches
    if (payment.order_id !== razorpay_order_id) {
      console.warn(`❌ Order ID mismatch: expected ${razorpay_order_id}, got ${payment.order_id}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Order ID mismatch');
      return res.status(400).json({
        success: false,
        error: 'Order ID mismatch'
      });
    }

    // Step 4b: AUTHORITATIVE ORDER BINDING VERIFICATION (CRITICAL SECURITY)
    // Check if the order exists in Bridge DB and verify bound sessionId, transactionId, kioskId, and amount
    const boundOrder = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(razorpay_order_id);
    if (!boundOrder) {
      console.error(`❌ SECURITY REJECTION: Order ${razorpay_order_id} not found in Payment Bridge orders database.`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Order binding not found in Bridge DB');
      return res.status(400).json({
        success: false,
        error: 'Order binding not found in Payment Bridge database. Razorpay orders must be created via Payment Bridge /create-order endpoint.'
      });
    }

    if (boundOrder.session_id !== sessionId) {
      console.error(`❌ SECURITY ATTACK: Session ID mismatch for order ${razorpay_order_id}. Bound: ${boundOrder.session_id}, Submitted: ${sessionId}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Authoritative session binding mismatch');
      return res.status(400).json({
        success: false,
        error: 'Authoritative session binding mismatch. Order was created for a different session.'
      });
    }
    if (boundOrder.transaction_id !== transactionId) {
      console.error(`❌ SECURITY ATTACK: Transaction ID mismatch for order ${razorpay_order_id}. Bound: ${boundOrder.transaction_id}, Submitted: ${transactionId}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Authoritative transaction binding mismatch');
      return res.status(400).json({
        success: false,
        error: 'Authoritative transaction binding mismatch. Order was created for a different transaction.'
      });
    }
    if (boundOrder.kiosk_id && boundOrder.kiosk_id !== kioskId) {
      console.error(`❌ SECURITY ATTACK: Kiosk ID mismatch for order ${razorpay_order_id}. Bound: ${boundOrder.kiosk_id}, Submitted: ${kioskId}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Authoritative kiosk binding mismatch');
      return res.status(400).json({
        success: false,
        error: 'Authoritative kiosk binding mismatch.'
      });
    }
    if (boundOrder.amount !== payment.amount) {
      console.error(`❌ SECURITY ATTACK: Amount mismatch for order ${razorpay_order_id}. Bound: ${boundOrder.amount}, Payment: ${payment.amount}`);
      logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'FAILED', 'Authoritative amount mismatch');
      return res.status(400).json({
        success: false,
        error: 'Authoritative order amount mismatch.'
      });
    }
    console.log(`✅ Authoritative order binding verified for order: ${razorpay_order_id}`);

    console.log(`✅ Payment verified with Razorpay API: ₹${payment.amount / 100}`);

    // Step 5: Create signed payment authorization
    const now = Date.now();
    const authorization = {
      sessionId,
      transactionId,
      kioskId,
      amount: payment.amount, // paise
      currency: payment.currency,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      issuedAt: now,
      expiresAt: now + (5 * 60 * 1000), // 5 minutes
      nonce: generateNonce(),
      version: '1.0'
    };

    // Sign with private key
    const signature = signAuthorization(authorization);

    // Persist to database
    const authId = storeAuthorization(kioskId, authorization, signature);

    // Log successful verification
    logVerification(razorpay_payment_id, sessionId, transactionId, payment.amount, 'SUCCESS');

    const duration = Date.now() - startTime;
    console.log(`✅ Payment authorization signed (${duration}ms)`);
    console.log(`   Auth ID: ${authId}`);
    console.log(`   Session: ${sessionId}, Transaction: ${transactionId}`);
    console.log(`   Amount: ₹${payment.amount / 100}, Nonce: ${authorization.nonce.substring(0, 16)}...`);

    // Return authorization to customer site (NOT to Pi)
    // Customer site will deliver it to Pi via form POST
    res.json({
      success: true,
      authorization,
      signature
    });

  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * GET /health
 * Diagnostic health endpoint
 */
app.get('/health', (req, res) => {
    let databaseHealthy = false;

    try {
        db.prepare('SELECT 1 AS ok').get();
        databaseHealthy = true;
    } catch {
        databaseHealthy = false;
    }

    res.status(databaseHealthy ? 200 : 503).json({
        status: databaseHealthy ? 'healthy' : 'degraded',
        service: 'Reliv Payment Bridge',
        version: '1.0.0',

        razorpay: Boolean(
            process.env.RAZORPAY_KEY_ID &&
            process.env.RAZORPAY_KEY_SECRET
        ),

        privateKey: Boolean(privateKey),

        paymentV2: paymentV2Service.isConfigured(),

        database: databaseHealthy,

        uptimeSeconds: Math.floor(process.uptime())
    });
});

/**
 * GET /ready
 * Readiness endpoint
 */
app.get('/ready', (req, res) => {
    try {
        db.prepare('SELECT 1').get();

        if (!privateKey) {
            throw new Error('Private key unavailable');
        }

        if (
            !process.env.RAZORPAY_KEY_ID ||
            !process.env.RAZORPAY_KEY_SECRET
        ) {
            throw new Error('Razorpay configuration unavailable');
        }

        return res.status(200).json({
            ready: true,
            service: 'Reliv Payment Bridge'
        });

    } catch (error) {
        return res.status(503).json({
            ready: false,
            service: 'Reliv Payment Bridge'
        });
    }
});

// Final JSON 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Safe global error handler
app.use((err, req, res, next) => {
    console.error('❌ Unhandled request error:', err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n⚠️ ${signal} received. Shutting down...`);

    try {
        if (db) {
            db.close();
            console.log('✅ Payment database closed');
        }
    } catch (error) {
        console.error(
            '⚠️ Error while closing database:',
            error.message
        );
    }

    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Final listener
const server = app.listen(PORT, HOST, () => {
    console.log('');
    console.log('══════════════════════════════════════════════');
    console.log('🔐 RELIV CLOUD PAYMENT BRIDGE');
    console.log('══════════════════════════════════════════════');
    console.log(`Host: ${HOST}`);
    console.log(`Port: ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
    console.log('══════════════════════════════════════════════');
});
