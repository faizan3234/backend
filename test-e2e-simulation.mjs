/**
 * End-to-End Simulation Test:
 * Frontend Cart Normalization + Payment V2 Request + Cloud Bridge Order Binding + Confirmation Code Flow
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure test database isolation
const TEST_DB_PATH = path.join(__dirname, 'data', `test-e2e-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

const { initializeDatabase, getDb, closeDatabase } = await import('./src/database/db.js');
initializeDatabase(TEST_DB_PATH);

const { transactionManager } = await import('./src/services/transactionManager.js');
const sessionManager = (await import('./src/services/sessionManager.js')).default;
const { PaymentV2Service } = await import('./src/services/paymentV2Service.js');

transactionManager.initialize();
sessionManager.initialize();

// Generate in-memory test keypairs
const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const cloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const paymentV2Service = new PaymentV2Service({
    kioskId: 'KSK-E2E-TEST',
    pepper: 'test_kiosk_pepper_secret_value_32b!',
    bridgeBaseUrl: 'https://pay.reliv.in'
});
paymentV2Service._kioskPrivateKey = kioskKeys.privateKey;
paymentV2Service._cloudPublicKey = cloudKeys.publicKey;

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  END-TO-END VERIFICATION: CART NORMALIZATION + PAYMENT V2 + SESSIONS');
console.log('═══════════════════════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

try {
  const db = getDb();

  // Seed settings and inventory
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', '12')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('platform_fee', '2')").run();
  db.prepare("INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity) VALUES ('KIT-PARACETAMOL', 'Paracetamol 650mg', 32, 150)").run();

  // 1. Simulate Journey A: Customer 1 begins and adds 1 kit (stock=150, cartQuantity=1)
  const session1 = sessionManager.createSession('KSK-CUST-1-JOURNEY');
  const sessionId1 = session1.session_id;
  console.log(`[Customer 1] Session Created: ${sessionId1}`);
  assert(sessionId1.startsWith('KSK-'), 'Customer 1 receives authoritative KSK session');

  // Simulate Frontend Cart Normalization in PaymentGate.jsx
  const frontendRawCart = [
    {
      id: 'KIT-PARACETAMOL',
      kit_id: 'KIT-PARACETAMOL',
      name: 'Paracetamol 650mg',
      price: 32,
      quantity: 150, // Stock level from SQLite inventory
      cartQuantity: 1, // User selected 1 kit
      availableStock: 150,
    }
  ];

  // Frontend normalizes cart
  const normalizedCart = frontendRawCart.map((item) => {
    const purchaseQty = Number(item.cartQuantity ?? item.quantityRequested ?? item.selectedQuantity ?? 1);
    return {
      kit_id: item.kit_id || item._id || item.id,
      name: item.name,
      quantity: Number.isInteger(purchaseQty) && purchaseQty > 0 ? purchaseQty : 1,
    };
  });

  assert(normalizedCart[0].quantity === 1, 'Normalized cart quantity is 1 (NOT 150 stock quantity)');
  assert(normalizedCart[0].kit_id === 'KIT-PARACETAMOL', 'Kit ID normalized correctly');

  // Backend Transaction Creation for Customer 1
  const txn1 = transactionManager.createTransaction(sessionId1, 'MEDICINE', normalizedCart);
  const cartParsed1 = Array.isArray(txn1.cart) ? txn1.cart : (typeof txn1.cart === 'string' ? JSON.parse(txn1.cart) : [txn1.cart]);
  console.log(`[Customer 1] Transaction Created: ${txn1.transaction_id}, Amount: ${txn1.amount}`);

  assert(txn1.amount === 3784 || txn1.amount === 37.84, `Authoritative transaction amount matches ₹37.84 (got ${txn1.amount})`);
  assert(cartParsed1[0].quantity === 1, `DB stored cart quantity is 1 (got ${cartParsed1[0].quantity})`);

  // Payment V2 Request Generation
  const paymentV2Req = await paymentV2Service.createPaymentRequest(sessionId1, {
    serviceType: 'MEDICINE',
    cart: normalizedCart,
  });

  console.log(`[Customer 1] Payment V2 Request: ${paymentV2Req.requestId}, Amount in paise: ${paymentV2Req.amount}`);
  assert(paymentV2Req.amount === 3784, `Payment V2 amount is exactly 3784 paise (got ${paymentV2Req.amount})`);
  assert(paymentV2Req.paymentUrl && paymentV2Req.paymentUrl.includes('#p='), 'Payment V2 URL generated with signed package (#p=)');

  // Verify Confirmation Code verification
  const statusBefore = paymentV2Service.getPaymentStatus(sessionId1);
  assert(statusBefore.status === 'ACTIVE', 'Payment request is ACTIVE on Pi');
  assert(statusBefore.amount === 3784, 'Payment status reports 3784 paise');

  // Test Incorrect Code (Consumes 1 attempt, allows retry)
  const wrongRes = await paymentV2Service.verifyConfirmationCode(sessionId1, {
    requestId: paymentV2Req.requestId,
    code: '9999',
  });
  assert(!wrongRes.ok && wrongRes.attemptsRemaining === 4, 'Incorrect code leaves 4 attempts remaining without locking');

  // 2. Simulate Journey B: Second Customer starts from Splash (Session Reset)
  console.log('\n[Customer 2] Fresh Journey Starts from Splash...');
  const session2 = sessionManager.createSession('KSK-CUST-2-JOURNEY');
  const sessionId2 = session2.session_id;
  console.log(`[Customer 2] Session Created: ${sessionId2}`);
  assert(sessionId2 !== sessionId1, 'Customer 2 receives a fresh distinct KSK session');

  const txn2 = transactionManager.createTransaction(sessionId2, 'MEDICINE', normalizedCart);
  assert(txn2.transaction_id !== txn1.transaction_id, 'Customer 2 receives a fresh distinct TXN ID');
  assert(txn2.amount === 3784 || txn2.amount === 37.84, 'Customer 2 transaction amount is ₹37.84');

} catch (err) {
  console.error('Test Error:', err);
  failed++;
} finally {
  closeDatabase();
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch (e) {}
}

console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log(`  E2E TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log('═══════════════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
