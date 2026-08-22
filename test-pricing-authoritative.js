/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK — AUTHORITATIVE PRICING & TAX REGRESSION TEST SUITE
 * 
 * Verifies Requirements:
 * 1. Base price originates from SQLite `inventory.price`
 * 2. Exact authoritative math:
 *    - subtotalPaise    = sum(itemBasePrice * qty)
 *    - taxPaise         = Math.round(subtotalPaise * (taxRate / 100)) [default 12%]
 *    - platformFeePaise = Math.round(platformFeeRupees * 100) [default ₹2.00]
 *    - totalPaise       = subtotalPaise + taxPaise + platformFeePaise
 * 3. Base ₹32 kit (1 qty) + 12% GST + ₹2 platform fee:
 *    - subtotalPaise    = 3200 (₹32.00)
 *    - taxPaise         = 384  (₹3.84)
 *    - platformFeePaise = 200  (₹2.00)
 *    - totalPaise       = 3784 (₹37.84)
 * 4. Qty 2 of Base ₹32 kit:
 *    - subtotalPaise    = 6400 (₹64.00)
 *    - taxPaise         = 768  (₹7.68)
 *    - platformFeePaise = 200  (₹2.00)
 *    - totalPaise       = 7368 (₹73.68)
 * 5. Mixed multi-kit carts with accurate itemized and aggregate totals
 * 6. Payment V2 transaction.amount matches the authoritative total in paise (3784)
 * 7. Fail-closed on missing kit, invalid price, invalid quantity, insufficient stock, invalid tax/fee config
 * 8. Zero leakage into production `data/kiosk.db` (complete test isolation)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { initializeDatabase, getDb, getDatabasePath, closeDatabase } from './src/database/db.js';
import sessionManager from './src/services/sessionManager.js';
import { transactionManager, TransactionManager } from './src/services/transactionManager.js';
import settingsManager from './src/services/settingsManager.js';
import { PricingService, pricingService } from './src/services/pricingService.js';
import { PaymentV2Service } from './src/services/paymentV2Service.js';
import { PaymentFinalizationService } from './src/services/paymentFinalizationService.js';
import fulfillmentManager from './src/services/fulfillmentManager.js';
import { decryptPackage } from './src/services/paymentV2Crypto.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${message}`);
    } else {
        failed++;
        console.error(`  ❌ FAIL: ${message}`);
    }
}

function section(name) {
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(`  ${name}`);
    console.log(`══════════════════════════════════════════════════`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SETUP ISOLATED TEST DATABASE
// ═══════════════════════════════════════════════════════════════════════════
const TEST_DB_PATH = path.resolve('./data/test-authoritative-pricing.db');
if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}
process.env.DB_PATH = TEST_DB_PATH;

const db = initializeDatabase(TEST_DB_PATH);
sessionManager.initialize();
transactionManager.initialize();
settingsManager.initialize();

// Guard: assert that test is NOT connected to production kiosk.db
assert(
    !getDatabasePath().endsWith('kiosk.db'),
    `TEST DB ISOLATION GUARD: Connected to test DB (${TEST_DB_PATH}), not production kiosk.db`
);

// Setup in-memory keys
const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const cloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const TEMP_KEY_DIR = './data/test-pricing-keys';
if (!fs.existsSync(TEMP_KEY_DIR)) fs.mkdirSync(TEMP_KEY_DIR, { recursive: true });
const tempKioskPrivPath = path.join(TEMP_KEY_DIR, 'test-kiosk-priv.pem');
const tempCloudPubPath = path.join(TEMP_KEY_DIR, 'test-cloud-pub.pem');
fs.writeFileSync(tempKioskPrivPath, kioskKeys.privateKey);
fs.writeFileSync(tempCloudPubPath, cloudKeys.publicKey);

const TEST_PEPPER = 'test_pepper_for_pricing_suite_1234567890';

// Mock MQTT
fulfillmentManager.mqttClient = {
    publish: (topic, payload, opts, cb) => cb ? cb(null) : null,
    connected: true
};

const finalizationService = new PaymentFinalizationService({
    db,
    sessionManager,
    transactionManager,
    fulfillmentManager
});

const v2Service = new PaymentV2Service({
    db,
    sessionManager,
    transactionManager,
    paymentFinalizationService: finalizationService,
    pepper: TEST_PEPPER,
    kioskSigningPrivateKeyPath: tempKioskPrivPath,
    cloudEncryptionPublicKeyPath: tempCloudPubPath,
    kioskId: 'RELIV-001'
});

// Seed inventory items in isolated test DB
db.prepare(`
    INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id)
    VALUES 
        ('KIT-BASE-32', 'Reliv Test Kit ₹32', 32, 100, 1),
        ('KIT-BASE-50', 'Reliv First Aid ₹50', 50, 50, 2),
        ('KIT-BASE-120', 'Reliv Vitamin Pack ₹120', 120, 30, 3),
        ('KIT-OUT-OF-STOCK', 'Out of stock kit', 40, 0, 4)
`).run();

// Explicitly set 12% GST and ₹2 platform fee in test DB settings
settingsManager.setTaxRate(12);
settingsManager.setPlatformFee(2);

// ═══════════════════════════════════════════════════════════════════════════
// RUN TESTS
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n🚀 RUNNING AUTHORITATIVE PRICING & TAX TEST SUITE\n');

// ───────────────────────────────────────────────────────────────────────────
// TEST 1: BASE ₹32 KIT (1 qty) + 12% GST + ₹2 PLATFORM FEE -> 3784 PAISE (₹37.84)
// ───────────────────────────────────────────────────────────────────────────
section('1. Single Item: Base ₹32 + 12% GST + ₹2 Platform Fee');

const pricingSingle = pricingService.calculateAuthoritativeCartTotal([
    { kit_id: 'KIT-BASE-32', quantity: 1 }
]);

assert(pricingSingle.subtotalPaise === 3200, 'Subtotal is 3200 paise (₹32.00)');
assert(pricingSingle.taxPaise === 384, 'Tax is 384 paise (12% of ₹32 = ₹3.84)');
assert(pricingSingle.platformFeePaise === 200, 'Platform fee is 200 paise (₹2.00)');
assert(pricingSingle.totalPaise === 3784, 'Total is 3784 paise (₹37.84)');
assert(pricingSingle.totalRupees === 37.84, 'Total rupees matches 37.84');
assert(pricingSingle.taxRate === 12, 'Tax rate is 12%');
assert(pricingSingle.platformFeeRupees === 2, 'Platform fee is ₹2.00');
assert(pricingSingle.items.length === 1, '1 item in breakdown');
assert(pricingSingle.items[0].unitPricePaise === 3200, 'Item unit price is 3200 paise');

// ───────────────────────────────────────────────────────────────────────────
// TEST 2: QUANTITY 2 OF BASE ₹32 KIT
// ───────────────────────────────────────────────────────────────────────────
section('2. Quantity 2 of Base ₹32 Kit');

const pricingQty2 = pricingService.calculateAuthoritativeCartTotal([
    { kit_id: 'KIT-BASE-32', quantity: 2 }
]);

assert(pricingQty2.subtotalPaise === 6400, 'Subtotal for qty 2 is 6400 paise (₹64.00)');
assert(pricingQty2.taxPaise === 768, 'Tax for qty 2 is 768 paise (12% of ₹64 = ₹7.68)');
assert(pricingQty2.platformFeePaise === 200, 'Platform fee is 200 paise (₹2.00 order-level)');
assert(pricingQty2.totalPaise === 7368, 'Total for qty 2 is 7368 paise (₹73.68)');
assert(pricingQty2.totalRupees === 73.68, 'Total rupees is 73.68');

// ───────────────────────────────────────────────────────────────────────────
// TEST 3: MIXED CART PRICING
// ───────────────────────────────────────────────────────────────────────────
section('3. Mixed Multi-Kit Cart');

const mixedCart = [
    { kit_id: 'KIT-BASE-32', quantity: 1 },  // 3200 base
    { kit_id: 'KIT-BASE-50', quantity: 2 },  // 10000 base
    { kit_id: 'KIT-BASE-120', quantity: 1 }  // 12000 base -> Total subtotal: 25200
];

const pricingMixed = pricingService.calculateAuthoritativeCartTotal(mixedCart);

assert(pricingMixed.subtotalPaise === 25200, 'Mixed subtotal is 25200 paise (₹252.00)');
assert(pricingMixed.taxPaise === 3024, 'Mixed tax is 3024 paise (12% of ₹252 = ₹30.24)');
assert(pricingMixed.platformFeePaise === 200, 'Mixed platform fee is 200 paise (₹2.00)');
assert(pricingMixed.totalPaise === 28424, 'Mixed total is 28424 paise (₹284.24)');
assert(pricingMixed.items.length === 3, '3 items in itemized breakdown');

// ───────────────────────────────────────────────────────────────────────────
// TEST 4: INTEGRATION WITH TRANSACTION MANAGER & PAYMENT V2
// ───────────────────────────────────────────────────────────────────────────
section('4. TransactionManager & Payment V2 Integration');

const session = sessionManager.createSession('RELIV-001', 'MEDICINE');
const tx = transactionManager.createTransaction(session.session_id, 'MEDICINE', [
    { kit_id: 'KIT-BASE-32', quantity: 1 }
]);

assert(tx.amount === 3784, 'Transaction amount is authoritatively ₹37.84 (3784 paise)');

(async () => {
    const v2Req = await v2Service.createPaymentRequest(session.session_id);
    assert(v2Req.amount === 3784, 'Payment V2 request amount matches authoritative 3784 paise');

    // Decrypt package to inspect canonical payload amount
    const decrypted = decryptPackage(v2Req.paymentUrl.split('#p=')[1], cloudKeys.privateKey);
    assert(decrypted.payload.amount === 3784, 'Encrypted package inside QR contains exact authoritative 3784 paise');
    assert(decrypted.payload.kioskId === 'RELIV-001', 'Package contains correct kiosk ID');

    // ───────────────────────────────────────────────────────────────────────
    // TEST 5: CLIENT AMOUNT TAMPERING RESISTANCE
    // ───────────────────────────────────────────────────────────────────────
    section('5. Tampering Resistance');

    const sessionTamper = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const txTamper = transactionManager.createTransaction(sessionTamper.session_id, 'MEDICINE', [
        { kit_id: 'KIT-BASE-32', quantity: 1, price: 1, amount: 100, totalPrice: 5 } // Malicious client fields
    ]);

    assert(txTamper.amount === 3784, 'Tampered client amounts are completely ignored (retains 3784 paise)');

    // ───────────────────────────────────────────────────────────────────────
    // TEST 6: FAIL-CLOSED VALIDATIONS
    // ───────────────────────────────────────────────────────────────────────
    section('6. Fail-Closed Boundary Validations');

    // 6.1 Non-existent kit
    let nonExistentThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'NON-EXISTENT-KIT-999', quantity: 1 }]);
    } catch (e) {
        nonExistentThrown = e.code === 'KIT_NOT_FOUND' || e.message.includes('not found');
    }
    assert(nonExistentThrown, 'Fail-closed: Missing kit in inventory throws error');

    // 6.2 Invalid / negative quantity
    let invalidQtyThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-BASE-32', quantity: -2 }]);
    } catch (e) {
        invalidQtyThrown = e.code === 'INVALID_QUANTITY' || e.message.includes('positive integer');
    }
    assert(invalidQtyThrown, 'Fail-closed: Negative quantity throws error');

    // 6.3 Non-integer quantity
    let floatQtyThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-BASE-32', quantity: 1.5 }]);
    } catch (e) {
        floatQtyThrown = e.code === 'INVALID_QUANTITY' || e.message.includes('positive integer');
    }
    assert(floatQtyThrown, 'Fail-closed: Float/fractional quantity throws error');

    // 6.4 Insufficient stock
    let stockThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-OUT-OF-STOCK', quantity: 1 }]);
    } catch (e) {
        stockThrown = e.code === 'INSUFFICIENT_STOCK' || e.message.includes('Insufficient stock');
    }
    assert(stockThrown, 'Fail-closed: Insufficient stock throws error');

    // 6.5 Empty cart
    let emptyCartThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([]);
    } catch (e) {
        emptyCartThrown = e.code === 'EMPTY_CART' || e.message.includes('requires at least one');
    }
    assert(emptyCartThrown, 'Fail-closed: Empty cart throws error');

    // 6.6 Invalid tax configuration
    let invalidTaxThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-BASE-32', quantity: 1 }], { taxRate: -5 });
    } catch (e) {
        invalidTaxThrown = e.code === 'INVALID_TAX_CONFIG' || e.message.includes('Invalid tax configuration');
    }
    assert(invalidTaxThrown, 'Fail-closed: Negative tax rate throws error');

    let excessiveTaxThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-BASE-32', quantity: 1 }], { taxRate: 150 });
    } catch (e) {
        excessiveTaxThrown = e.code === 'INVALID_TAX_CONFIG' || e.message.includes('Invalid tax configuration');
    }
    assert(excessiveTaxThrown, 'Fail-closed: >100% tax rate throws error');

    // 6.7 Invalid platform fee configuration
    let invalidFeeThrown = false;
    try {
        pricingService.calculateAuthoritativeCartTotal([{ kit_id: 'KIT-BASE-32', quantity: 1 }], { platformFee: -2 });
    } catch (e) {
        invalidFeeThrown = e.code === 'INVALID_PLATFORM_FEE_CONFIG' || e.message.includes('Invalid platform fee');
    }
    assert(invalidFeeThrown, 'Fail-closed: Negative platform fee throws error');

    // ───────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════');
    console.log(`  RESULTS: ${passed} PASS, ${failed} FAIL (${passed + failed} total)`);
    console.log('══════════════════════════════════════════════════\n');

    // Cleanup
    closeDatabase();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
    try { fs.rmSync(TEMP_KEY_DIR, { recursive: true }); } catch {}

    process.exit(failed > 0 ? 1 : 0);
})();
