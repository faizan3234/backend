import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import Razorpay from 'razorpay';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

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
 *   transactionId: string
 * }
 * 
 * Response:
 * {
 *   success: true,
 *   authorization: {
 *     sessionId,
 *     transactionId,
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
      transactionId
    } = req.body;

    // Validation
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: 'Missing required Razorpay parameters'
      });
    }

    if (!sessionId || !transactionId) {
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
      return res.status(500).json({
        success: false,
        error: 'Failed to verify payment with Razorpay'
      });
    }

    // Step 3: Verify payment status
    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      console.warn(`❌ Payment not captured: ${razorpay_payment_id} (status: ${payment.status})`);
      return res.status(400).json({
        success: false,
        error: `Payment not successful (status: ${payment.status})`
      });
    }

    // Step 4: Verify order ID matches
    if (payment.order_id !== razorpay_order_id) {
      console.warn(`❌ Order ID mismatch: expected ${razorpay_order_id}, got ${payment.order_id}`);
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

    const duration = Date.now() - startTime;
    console.log(`✅ Payment authorization signed (${duration}ms)`);
    console.log(`   Session: ${sessionId}, Transaction: ${transactionId}`);
    console.log(`   Amount: ₹${payment.amount / 100}, Nonce: ${authorization.nonce.substring(0, 16)}...`);

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
    privateKey: !!privateKey
  });
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
  console.log('');
  console.log('📋 Endpoints:');
  console.log(`   POST http://localhost:${PORT}/verify-payment`);
  console.log(`   GET  http://localhost:${PORT}/health`);
  console.log('');
  console.log('⚠️  This service MUST have Internet access to Razorpay API');
  console.log('    The Raspberry Pi does NOT need Internet access.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});
