import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import Razorpay from 'razorpay';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load private key for signing payment authorizations
let privateKey;
try {
  privateKey = fs.readFileSync('./private-key.pem', 'utf8');
  console.log('✅ Private key loaded for payment authorization signing');
} catch (error) {
  console.error('❌ CRITICAL: Private key not found. Run: npm run generate-keys');
  process.exit(1);
}

// Initialize Razorpay (Payment Bridge has Internet access)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

console.log('✅ Razorpay client initialized');

// Initialize database
let db;
try {
  db = new Database('./bridge.db');
  db.pragma('journal_mode = WAL');
  console.log('✅ Database connected');
} catch (error) {
  console.error('❌ CRITICAL: Database initialization failed. Run: npm run init-db');
  process.exit(1);
}

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
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'Reliv Payment Bridge',
    version: '1.0.0',
    razorpay: !!process.env.RAZORPAY_KEY_ID,
    privateKey: !!privateKey,
    database: !!db
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n⚠️  Received SIGTERM, shutting down gracefully...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n⚠️  Received SIGINT, shutting down gracefully...');
  db.close();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔐 RELIV PAYMENT BRIDGE SERVICE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Status: RUNNING`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Razorpay: ${process.env.RAZORPAY_KEY_ID ? 'Configured' : 'NOT CONFIGURED'}`);
  console.log(`   Private Key: Loaded`);
  console.log(`   Database: Connected (persistent storage)`);
  console.log('');
  console.log('📋 Endpoints:');
  console.log(`   POST http://localhost:${PORT}/verify-payment`);
  console.log(`   GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('🔄 TRANSPORT MODEL:');
  console.log('   1. Customer phone → Payment Bridge (HTTPS)');
  console.log('   2. Bridge verifies with Razorpay API');
  console.log('   3. Bridge signs authorization (RSA private key)');
  console.log('   4. Bridge returns to customer site');
  console.log('   5. Customer site POSTs to Pi (browser form)');
  console.log('   6. Pi verifies locally (RSA public key)');
  console.log('');
  console.log('⚠️  This service MUST have Internet access to Razorpay API');
  console.log('    The Raspberry Pi does NOT need Internet access.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});
