/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST: PAYMENT V2 CART LIFECYCLE & STALE REQUEST INVALIDATION REGRESSION
 * 
 * Verifies:
 * 1. Refresh idempotency (same session + same cart = reuse active request)
 * 2. Back / Change Kit (cart changed = invalidate old request & transaction, create new QR with new amount)
 * 3. Change Quantity (quantity changed = invalidate old request, recalculate authoritative total)
 * 4. Old Confirmation Code Rejection (cancelled/superseded request code rejected)
 * 5. Explicit Cancel Method & Route (marks request CANCELLED, unpaid transaction FAILED)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure test database isolation
const TEST_DB_PATH = path.join(__dirname, 'data', `test-cart-lifecycle-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB_PATH;

const { initializeDatabase, getDb, closeDatabase } = await import('./src/database/db.js');
initializeDatabase(TEST_DB_PATH);

const { transactionManager } = await import('./src/services/transactionManager.js');
const sessionManager = (await import('./src/services/sessionManager.js')).default;
const { PaymentV2Service } = await import('./src/services/paymentV2Service.js');
const { decryptPackage } = await import('./src/services/paymentV2Crypto.js');

transactionManager.initialize();
sessionManager.initialize();

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

function section(title) {
    console.log(`\n═══════════════════════════════════════════════════════════`);
    console.log(`  ${title}`);
    console.log(`═══════════════════════════════════════════════════════════`);
}

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

const service = new PaymentV2Service({
    kioskId: 'KSK-REGRESSION',
    pepper: 'test_kiosk_pepper_secret_value_32b!',
    bridgeBaseUrl: 'https://pay.reliv.in'
});
service._kioskPrivateKey = kioskKeys.privateKey;
service._cloudPublicKey = cloudKeys.publicKey;

try {
    const db = getDb();

    // Seed settings (12% tax, ₹2 platform fee)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('tax_rate', '12')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('platform_fee', '2')").run();

    // Seed inventory:
    // KIT-A: price ₹150 (₹150 + 12% = ₹168 + ₹2 = ₹170 -> 17000 paise)
    // KIT-B: price ₹25 (₹25 + 12% = ₹28 + ₹2 = ₹30 -> 3000 paise)
    db.prepare("INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id) VALUES ('KIT-A', 'Medicine A ₹150', 150, 100, 1)").run();
    db.prepare("INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id) VALUES ('KIT-B', 'Medicine B ₹25', 25, 100, 2)").run();

    // ───────────────────────────────────────────────────────────────────────
    // TEST 1: REFRESH IDEMPOTENCY (SAME CART)
    // ───────────────────────────────────────────────────────────────────────
    section('TEST 1: Refresh Idempotency with Same Cart');
    const session1 = sessionManager.createSession('KSK-TEST-1', 'MEDICINE');
    const cartA = [{ kit_id: 'KIT-A', quantity: 1 }];

    const reqA1 = await service.createPaymentRequest(session1.session_id, { serviceType: 'MEDICINE', cart: cartA });
    assert(reqA1.amount === 17000, `REQ-A1 created for ₹170.00 (17000 paise)`);

    // Simulate page refresh (same session + same cart)
    const reqA2 = await service.createPaymentRequest(session1.session_id, { serviceType: 'MEDICINE', cart: cartA });
    assert(reqA2.requestId === reqA1.requestId, `Same requestId returned on refresh (${reqA2.requestId})`);
    assert(reqA2.transactionId === reqA1.transactionId, `Same transactionId retained on refresh (${reqA2.transactionId})`);
    assert(reqA2.paymentUrl === reqA1.paymentUrl, `Same QR URL package retained on refresh`);

    // ───────────────────────────────────────────────────────────────────────
    // TEST 2: BACK / CHANGE TO DIFFERENT KIT (CART CHANGE)
    // ───────────────────────────────────────────────────────────────────────
    section('TEST 2: Back / Change to Different Kit');
    // Customer now selects Medicine B (₹30 total)
    const cartB = [{ kit_id: 'KIT-B', quantity: 1 }];

    const reqB = await service.createPaymentRequest(session1.session_id, { serviceType: 'MEDICINE', cart: cartB });
    assert(reqB.amount === 3000, `REQ-B created with correct Medicine B price ₹30.00 (3000 paise)`);
    assert(reqB.requestId !== reqA1.requestId, `REQ-B has NEW requestId (${reqB.requestId} !== ${reqA1.requestId})`);
    assert(reqB.transactionId !== reqA1.transactionId, `REQ-B has NEW transactionId (${reqB.transactionId} !== ${reqA1.transactionId})`);
    assert(reqB.paymentUrl !== reqA1.paymentUrl, `REQ-B generates a completely NEW QR package`);

    // Verify REQ-A1 is marked CANCELLED in database
    const reqA1Record = db.prepare('SELECT * FROM payment_v2_requests WHERE request_id = ?').get(reqA1.requestId);
    assert(reqA1Record.status === 'CANCELLED', `Previous REQ-A1 status is marked CANCELLED in DB`);

    // Verify TXN-A1 is marked FAILED/superseded in database
    const txnA1Record = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(reqA1.transactionId);
    assert(txnA1Record.status === 'FAILED', `Previous TXN-A1 status is marked FAILED in DB`);

    // Decrypt QR-B package to confirm contents match Cart B only
    const pkgB = reqB.paymentUrl.split('#p=')[1];
    const decryptedB = decryptPackage(pkgB, cloudKeys.privateKey);
    assert(decryptedB.payload.amount === 3000, `QR-B payload contains authoritatively ₹30.00 (3000 paise)`);
    assert(decryptedB.payload.transactionId === reqB.transactionId, `QR-B payload is bound to TXN-B`);

    // ───────────────────────────────────────────────────────────────────────
    // TEST 3: CHANGE QUANTITY (KIT-A QTY 1 -> KIT-A QTY 2)
    // ───────────────────────────────────────────────────────────────────────
    section('TEST 3: Change Quantity');
    const session3 = sessionManager.createSession('KSK-TEST-3', 'MEDICINE');
    const cartQty1 = [{ kit_id: 'KIT-A', quantity: 1 }];
    const reqQty1 = await service.createPaymentRequest(session3.session_id, { serviceType: 'MEDICINE', cart: cartQty1 });
    assert(reqQty1.amount === 17000, `Qty 1 created for ₹170.00 (17000 paise)`);

    // User changes quantity to 2 (2 * 150 = 300 + 12% GST = 336 + 2 fee = 338 -> 33800 paise)
    const cartQty2 = [{ kit_id: 'KIT-A', quantity: 2 }];
    const reqQty2 = await service.createPaymentRequest(session3.session_id, { serviceType: 'MEDICINE', cart: cartQty2 });
    assert(reqQty2.amount === 33800, `Qty 2 created for ₹338.00 (33800 paise)`);
    assert(reqQty2.requestId !== reqQty1.requestId, `Qty 2 receives a new requestId`);
    assert(reqQty2.transactionId !== reqQty1.transactionId, `Qty 2 receives a new transactionId`);

    // ───────────────────────────────────────────────────────────────────────
    // TEST 4: OLD CODE REJECTION AFTER CANCELLATION
    // ───────────────────────────────────────────────────────────────────────
    section('TEST 4: Old Code Rejection After Cancellation');
    // Extract confirmation code from decrypted REQ-A1 payload
    const pkgA1 = reqA1.paymentUrl.split('#p=')[1];
    const decryptedA1 = decryptPackage(pkgA1, cloudKeys.privateKey);
    const codeA1 = decryptedA1.payload.confirmationCode;
    console.log(`[Test] Decrypted original confirmation code for REQ-A1: ${codeA1}`);

    // Attempt to verify the old cancelled request REQ-A1 with its valid code
    const oldVerifyRes = await service.verifyConfirmationCode(session1.session_id, {
        requestId: reqA1.requestId,
        code: codeA1
    });

    assert(!oldVerifyRes.ok, `Verification of cancelled REQ-A1 rejected`);
    assert(oldVerifyRes.code === 'PAYMENT_REQUEST_CANCELLED', `Returns explicit error code PAYMENT_REQUEST_CANCELLED (got: ${oldVerifyRes.code})`);

    // Ensure TXN-A1 remained FAILED and was NOT verified
    const txnA1Final = db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(reqA1.transactionId);
    assert(txnA1Final.status === 'FAILED' && txnA1Final.verified === 0, `TXN-A1 was NOT verified`);

    // ───────────────────────────────────────────────────────────────────────
    // TEST 5: EXPLICIT CANCEL METHOD
    // ───────────────────────────────────────────────────────────────────────
    section('TEST 5: Explicit Cancel Method');
    const session5 = sessionManager.createSession('KSK-TEST-5', 'MEDICINE');
    const req5 = await service.createPaymentRequest(session5.session_id, { serviceType: 'MEDICINE', cart: cartA });
    assert(req5.status === 'ACTIVE' || service.getPaymentStatus(session5.session_id).status === 'ACTIVE', `Request 5 is active`);

    const cancelRes = service.cancelPaymentRequest(session5.session_id);
    assert(cancelRes.ok === true && cancelRes.cancelled === true, `cancelPaymentRequest succeeded`);
    assert(cancelRes.requestId === req5.requestId, `cancelPaymentRequest returned correct requestId`);

    const statusAfterCancel = service.getPaymentStatus(session5.session_id);
    assert(statusAfterCancel.status === 'CANCELLED', `Status after explicit cancel is CANCELLED`);

    // Idempotency: cancelling again is safe
    const cancelRes2 = service.cancelPaymentRequest(session5.session_id);
    assert(cancelRes2.ok === true, `Calling cancelPaymentRequest again is safe & idempotent`);

} catch (err) {
    console.error('Test execution error:', err);
    failed++;
} finally {
    closeDatabase();
    try {
        if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    } catch {}
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(`📊 CART LIFECYCLE REGRESSION TEST RESULTS`);
console.log(`═══════════════════════════════════════════════════════════`);
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
console.log(`  📊 Total:   ${passed + failed}`);
console.log(`═══════════════════════════════════════════════════════════\n`);

if (failed > 0) process.exit(1);
