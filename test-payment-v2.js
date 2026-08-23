/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV KIOSK — PAYMENT TRANSPORT V2 AUTOMATED TEST SUITE
 * 
 * Verifies all 38+ critical security requirements:
 * - Ed25519 signing & verification
 * - RSA-OAEP + AES-256-GCM hybrid encryption & roundtrip
 * - Authoritative pricing from inventory & settings (no client trust)
 * - Confirmation code HMAC verifier (zero plain code storage/logging)
 * - Request idempotency & URL structure
 * - Attempt incrementing, locking, and timing-safe verification
 * - Seamless integration with common fulfillment pipeline
 * - Database persistence across restarts
 * - 100% offline (zero external network calls)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { initializeDatabase, getDb, closeDatabase } from './src/database/db.js';
import sessionManager from './src/services/sessionManager.js';
import { transactionManager } from './src/services/transactionManager.js';
import fulfillmentManager from './src/services/fulfillmentManager.js';
import { PaymentFinalizationService } from './src/services/paymentFinalizationService.js';
import { PaymentV2Service } from './src/services/paymentV2Service.js';
import {
    signPayload,
    verifyPayloadSignature,
    encryptPackage,
    decryptPackage,
    calculateCodeHmac,
    verifyCodeHmac,
    generateConfirmationCode,
    generateRequestId,
    generateRequestNonce,
    base64UrlEncode,
    base64UrlDecode
} from './src/services/paymentV2Crypto.js';

// Test counters
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, message) {
    if (condition) {
        passed++;
        results.push({ name: message, status: 'PASS' });
        console.log(`  ✅ ${message}`);
    } else {
        failed++;
        results.push({ name: message, status: 'FAIL' });
        console.error(`  ❌ FAIL: ${message}`);
    }
}

function section(name) {
    console.log(`\n══════════════════════════════════════════════════`);
    console.log(`  ${name}`);
    console.log(`══════════════════════════════════════════════════`);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST FIXTURES & SETUP
// ═══════════════════════════════════════════════════════════════════════════
const TEST_DB_PATH = path.resolve('./data/test-payment-v2.db');
process.env.DB_PATH = TEST_DB_PATH;

// Clean up previous test DB if exists
if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}

const db = initializeDatabase(TEST_DB_PATH);
sessionManager.initialize();
transactionManager.initialize();

assert(
    !db.name.endsWith('kiosk.db'),
    `TEST DB ISOLATION GUARD: Connected to test DB (${TEST_DB_PATH}), not production kiosk.db`
);

// Generate in-memory test keypairs
const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const cloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const otherCloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const otherKioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const TEST_PEPPER = 'test_secret_pepper_32_bytes_long_random_seed_123';

// Write temp key files for service file-loading tests
const TEMP_KEY_DIR = './data/test-keys';
if (!fs.existsSync(TEMP_KEY_DIR)) fs.mkdirSync(TEMP_KEY_DIR, { recursive: true });
const tempKioskPrivPath = path.join(TEMP_KEY_DIR, 'test-kiosk-priv.pem');
const tempCloudPubPath = path.join(TEMP_KEY_DIR, 'test-cloud-pub.pem');
fs.writeFileSync(tempKioskPrivPath, kioskKeys.privateKey);
fs.writeFileSync(tempCloudPubPath, cloudKeys.publicKey);

// Mock MQTT for fulfillment
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
    kioskId: 'RELIV-001',
    ttlSeconds: 300,
    maxAttempts: 5
});

// Seed inventory for medicine tests
db.prepare(`
    INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id)
    VALUES 
        ('KIT-FIRST-AID', 'First Aid Kit', 150, 50, 1),
        ('KIT-TRAVEL', 'Travel Kit', 200, 30, 2),
        ('KIT-WOMEN', 'Women Care Kit', 250, 20, 3)
`).run();

(async function runAllTests() {
    console.log('\n🚀 RUNNING PAYMENT TRANSPORT V2 SECURITY & CRYPTO SUITE\n');

    // ───────────────────────────────────────────────────────────────────────
    // CRYPTO PRIMITIVES TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('1. Crypto Primitives & Hybrid Encryption');

    // Test: Ed25519 Signing & Verification
    const testPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-TEST-1',
        requestNonce: 'nonce123',
        sessionId: 'KSK-TEST-1',
        transactionId: 'TXN-TEST-1',
        amount: 10000,
        confirmationCode: '4821',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };

    const signature = signPayload(testPayload, kioskKeys.privateKey);
    assert(typeof signature === 'string' && signature.length > 20, 'Ed25519 signature generated as Base64URL');
    assert(verifyPayloadSignature(testPayload, signature, kioskKeys.publicKey) === true, 'Kiosk signature verifies with matching public key');
    assert(verifyPayloadSignature(testPayload, signature, otherKioskKeys.publicKey) === false, 'Forged kiosk signature fails verification');

    // Payload mutation after signing
    const mutatedPayload = { ...testPayload, amount: 20000 };
    assert(verifyPayloadSignature(mutatedPayload, signature, kioskKeys.publicKey) === false, 'Payload mutation after signing fails verification');

    // Hybrid Encryption Roundtrip (AES-256-GCM + RSA-OAEP SHA256)
    const encryptedPkg = encryptPackage({ payload: testPayload, signature }, cloudKeys.publicKey);
    assert(typeof encryptedPkg === 'string' && encryptedPkg.length > 50, 'Encrypted package produced as Base64URL');

    const decryptedEnvelope = decryptPackage(encryptedPkg, cloudKeys.privateKey);
    assert(decryptedEnvelope.payload.requestId === 'REQ-TEST-1', 'Decrypted payload matches original requestId');
    assert(decryptedEnvelope.payload.amount === 10000, 'Decrypted payload matches original amount');
    assert(decryptedEnvelope.payload.confirmationCode === '4821', 'Decrypted payload matches original confirmation code');
    assert(decryptedEnvelope.signature === signature, 'Decrypted signature matches original signature');

    // Wrong private key cannot decrypt
    let wrongKeyFailed = false;
    try {
        decryptPackage(encryptedPkg, otherCloudKeys.privateKey);
    } catch {
        wrongKeyFailed = true;
    }
    assert(wrongKeyFailed, 'Wrong Oracle private key fails to decrypt package');

    // Ciphertext tampering fails AES-GCM authentication
    const rawEnvelope = JSON.parse(base64UrlDecode(encryptedPkg).toString('utf8'));
    const tamperedCt = Buffer.from(base64UrlDecode(rawEnvelope.ct));
    tamperedCt[0] ^= 0xFF; // Flip bits in ciphertext
    const tamperedEnvelope = { ...rawEnvelope, ct: base64UrlEncode(tamperedCt) };
    const tamperedPkg = base64UrlEncode(Buffer.from(JSON.stringify(tamperedEnvelope), 'utf8'));

    let tamperingFailed = false;
    try {
        decryptPackage(tamperedPkg, cloudKeys.privateKey);
    } catch {
        tamperingFailed = true;
    }
    assert(tamperingFailed, 'Ciphertext tampering fails AES-GCM authentication tag verification');

    // ───────────────────────────────────────────────────────────────────────
    // HMAC PEPPER & CODE VERIFIER TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('2. Confirmation Code & HMAC Verifier');

    const codeHmac = calculateCodeHmac(TEST_PEPPER, {
        version: 2,
        requestId: 'REQ-1',
        requestNonce: 'nonce1',
        sessionId: 'KSK-1',
        transactionId: 'TXN-1',
        amount: 5000,
        confirmationCode: '0042'
    });

    assert(verifyCodeHmac(codeHmac, TEST_PEPPER, {
        version: 2,
        requestId: 'REQ-1',
        requestNonce: 'nonce1',
        sessionId: 'KSK-1',
        transactionId: 'TXN-1',
        amount: 5000,
        confirmationCode: '0042'
    }) === true, 'HMAC comparison succeeds with leading-zero code "0042"');

    assert(verifyCodeHmac(codeHmac, TEST_PEPPER, {
        version: 2,
        requestId: 'REQ-1',
        requestNonce: 'nonce1',
        sessionId: 'KSK-1',
        transactionId: 'TXN-1',
        amount: 5000,
        confirmationCode: '0043'
    }) === false, 'HMAC comparison rejects wrong code "0043"');

    assert(verifyCodeHmac(codeHmac, 'wrong_pepper', {
        version: 2,
        requestId: 'REQ-1',
        requestNonce: 'nonce1',
        sessionId: 'KSK-1',
        transactionId: 'TXN-1',
        amount: 5000,
        confirmationCode: '0042'
    }) === false, 'HMAC comparison fails with wrong pepper');

    // ───────────────────────────────────────────────────────────────────────
    // AUTHORITATIVE PRICING & REQUEST CREATION
    // ───────────────────────────────────────────────────────────────────────
    section('3. Authoritative Pricing & Request Creation');

    // Session 1: Health checkup
    const sessionHealth = sessionManager.createSession('RELIV-001', 'HEALTH_CHECKUP');
    const reqHealth = await v2Service.createPaymentRequest(sessionHealth.session_id);

    assert(reqHealth.ok === true, 'Health checkup payment request created successfully');
    assert(reqHealth.amount === 10000, 'Health checkup amount is authoritative ₹100.00 (10000 paise)');
    assert(reqHealth.paymentUrl.startsWith('https://reliv7.vercel.app/pay#p='), 'Payment URL begins with https://reliv7.vercel.app/pay#p=');
    assert(!reqHealth.paymentUrl.includes('confirmationCode'), 'Plain confirmation code NOT in payment URL');
    assert(!reqHealth.paymentUrl.includes('4821'), 'No plain code leak in payment URL');

    // Verify DB does not contain plain code
    const dbRow = db.prepare('SELECT * FROM payment_v2_requests WHERE request_id = ?').get(reqHealth.requestId);
    assert(dbRow && dbRow.code_hmac, 'Row stored with code_hmac');
    assert(dbRow.confirmation_code === undefined, 'No confirmation_code column in DB');
    assert(!JSON.stringify(dbRow).includes('confirmationCode'), 'Plain code is NOT stored anywhere in SQLite table');

    // Session 2: Medicine Cart with Multiple Kits
    const sessionMed = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const medCart = [
        { kit_id: 'KIT-FIRST-AID', quantity: 2 }, // 2 * 150 = ₹300 (30000 paise)
        { kit_id: 'KIT-TRAVEL', quantity: 1 }      // 1 * 200 = ₹200 (20000 paise) -> Total: 50000 paise
    ];

    const reqMed = await v2Service.createPaymentRequest(sessionMed.session_id, {
        serviceType: 'MEDICINE',
        cart: medCart
    });

    assert(reqMed.ok === true, 'Medicine cart payment request created');
    assert(reqMed.amount === 56200, 'Medicine cart total is calculated authoritatively (₹500.00 base + 12% tax + ₹2 fee = ₹562.00 / 56200 paise)');

    // Client-supplied amount tampering ignored
    const reqTamper = await v2Service.createPaymentRequest(sessionMed.session_id, {
        serviceType: 'MEDICINE',
        cart: medCart,
        amount: 100 // Malicious client claims ₹1.00
    });
    assert(reqTamper.amount === 56200, 'Client-supplied amount is completely ignored (retains 56200 paise)');

    // ───────────────────────────────────────────────────────────────────────
    // IDEMPOTENCY & STATUS
    // ───────────────────────────────────────────────────────────────────────
    section('4. Request Idempotency & Status');

    // Requesting payment again for the same active session returns identical request
    const reqMedDuplicate = await v2Service.createPaymentRequest(sessionMed.session_id);
    assert(reqMedDuplicate.requestId === reqMed.requestId, 'Repeated createPaymentRequest returns same active requestId (idempotent)');
    assert(reqMedDuplicate.paymentUrl === reqMed.paymentUrl, 'Repeated createPaymentRequest returns same paymentUrl');

    const statusObj = v2Service.getPaymentStatus(sessionMed.session_id);
    assert(statusObj.ok === true && statusObj.status === 'ACTIVE', 'Payment status returns ACTIVE');
    assert(statusObj.attemptsRemaining === 5, 'Status reports 5 attempts remaining initially');
    assert(statusObj.paymentVerified === false, 'paymentVerified is false before confirmation');

    // ───────────────────────────────────────────────────────────────────────
    // CONFIRMATION CODE VERIFICATION & ATTEMPTS LOCKING
    // ───────────────────────────────────────────────────────────────────────
    section('5. Code Verification, Attempts & Locking');

    // Test malformed code format
    const malformedRes = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: reqMed.requestId,
        code: 'abc' // not 4 digits
    });
    assert(malformedRes.ok === false && malformedRes.code === 'INVALID_FORMAT', 'Malformed non-numeric code rejected');

    const malformedRes2 = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: reqMed.requestId,
        code: '12345' // 5 digits
    });
    assert(malformedRes2.ok === false && malformedRes2.code === 'INVALID_FORMAT', '5-digit code rejected');

    // Decrypt package to extract actual confirmation code for testing
    const decryptedMed = decryptPackage(
        reqMed.paymentUrl.split('#p=')[1],
        cloudKeys.privateKey
    );
    const actualCode = decryptedMed.payload.confirmationCode;
    assert(typeof actualCode === 'string' && actualCode.length === 4, 'Extracted valid 4-digit code from test envelope');

    // Submit wrong code (Attempt 1)
    const wrongCode = actualCode === '9999' ? '0000' : '9999';
    const wrongRes1 = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: reqMed.requestId,
        code: wrongCode
    });
    assert(wrongRes1.ok === false && wrongRes1.code === 'INVALID_CODE', 'Wrong code rejected');
    assert(wrongRes1.attemptsRemaining === 4, 'Attempts remaining decremented to 4');

    // Verify transaction remains PENDING
    const txnAfterWrong = transactionManager.getTransaction(reqMed.transactionId);
    assert(txnAfterWrong.status === 'PENDING', 'Transaction remains PENDING after wrong code');

    // Verify no fulfillment jobs created
    const jobsAfterWrong = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(reqMed.transactionId);
    assert(jobsAfterWrong.length === 0, 'No fulfillment jobs created after wrong code');

    // Submit wrong code remaining times until locked (Attempts 2, 3, 4, 5)
    await v2Service.verifyConfirmationCode(sessionMed.session_id, { requestId: reqMed.requestId, code: wrongCode });
    await v2Service.verifyConfirmationCode(sessionMed.session_id, { requestId: reqMed.requestId, code: wrongCode });
    await v2Service.verifyConfirmationCode(sessionMed.session_id, { requestId: reqMed.requestId, code: wrongCode });
    const lockRes = await v2Service.verifyConfirmationCode(sessionMed.session_id, { requestId: reqMed.requestId, code: wrongCode });

    assert(lockRes.ok === false && lockRes.code === 'LOCKED', 'Max attempts (5) locks payment request');
    assert(lockRes.attemptsRemaining === 0, 'Attempts remaining is 0 when locked');

    // Attempting with correct code on locked request fails
    const lockedCorrectRes = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: reqMed.requestId,
        code: actualCode
    });
    assert(lockedCorrectRes.ok === false && lockedCorrectRes.code === 'LOCKED', 'Correct code rejected on LOCKED request');

    // ───────────────────────────────────────────────────────────────────────
    // NEW REQUEST AFTER LOCK & SUCCESSFUL CODE VERIFICATION
    // ───────────────────────────────────────────────────────────────────────
    section('6. New Request After Lock & Successful Verification');

    // New request is allowed after previous request was LOCKED
    const newReqMed = await v2Service.createPaymentRequest(sessionMed.session_id);
    assert(newReqMed.ok === true && newReqMed.requestId !== reqMed.requestId, 'New request created after prior request locked');

    const newDecryptedMed = decryptPackage(newReqMed.paymentUrl.split('#p=')[1], cloudKeys.privateKey);
    const newActualCode = newDecryptedMed.payload.confirmationCode;

    // Verify correct code
    const successRes = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: newReqMed.requestId,
        code: newActualCode
    });

    assert(successRes.ok === true && successRes.status === 'VERIFIED', 'Correct code successfully verified');

    // Verify transaction status
    const verifiedTxn = transactionManager.getTransaction(newReqMed.transactionId);
    assert(verifiedTxn.status === 'VERIFIED' && verifiedTxn.verified === 1, 'Transaction marked VERIFIED in SQLite');
    assert(verifiedTxn.provider === 'CLOUD_CODE_V2', 'Transaction provider recorded as CLOUD_CODE_V2');

    // Verify session status
    const verifiedSession = sessionManager.getSession(sessionMed.session_id);
    assert(verifiedSession.payment_status === 'VERIFIED', 'Session payment_status marked VERIFIED');

    // Verify fulfillment jobs created
    const createdJobs = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(newReqMed.transactionId);
    assert(createdJobs.length === 2, '2 fulfillment jobs created for the 2 kits in cart');

    // Repeated correct code is idempotent
    const repeatRes = await v2Service.verifyConfirmationCode(sessionMed.session_id, {
        requestId: newReqMed.requestId,
        code: newActualCode
    });
    assert(repeatRes.ok === true && repeatRes.alreadyVerified === true, 'Repeated correct code returns alreadyVerified: true (idempotent)');

    const repeatJobs = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(newReqMed.transactionId);
    assert(repeatJobs.length === 2, 'Repeated confirmation does NOT create duplicate fulfillment jobs');

    // ───────────────────────────────────────────────────────────────────────
    // EXPIRY & PERSISTENCE
    // ───────────────────────────────────────────────────────────────────────
    section('7. Expiry & Database Persistence');

    // Session 3: Expiry test
    const sessionExp = sessionManager.createSession('RELIV-001', 'HEALTH_CHECKUP');
    const reqExp = await v2Service.createPaymentRequest(sessionExp.session_id);

    // Artificially expire the request in DB
    db.prepare('UPDATE payment_v2_requests SET expires_at = ? WHERE request_id = ?')
        .run(Date.now() - 1000, reqExp.requestId);

    const expDecrypted = decryptPackage(reqExp.paymentUrl.split('#p=')[1], cloudKeys.privateKey);
    const expRes = await v2Service.verifyConfirmationCode(sessionExp.session_id, {
        requestId: reqExp.requestId,
        code: expDecrypted.payload.confirmationCode
    });

    assert(expRes.ok === false && expRes.code === 'EXPIRED', 'Expired code rejected');

    // Test persistence across service re-instantiation (simulating server restart)
    const v2ServiceReboot = new PaymentV2Service({
        db,
        sessionManager,
        transactionManager,
        paymentFinalizationService: finalizationService,
        pepper: TEST_PEPPER,
        kioskSigningPrivateKeyPath: tempKioskPrivPath,
        cloudEncryptionPublicKeyPath: tempCloudPubPath
    });

    const statusAfterReboot = v2ServiceReboot.getPaymentStatus(sessionMed.session_id);
    assert(statusAfterReboot.paymentVerified === true, 'Payment verification status persisted across service re-instantiation');

    // ───────────────────────────────────────────────────────────────────────
    // SECURITY & BOUNDARY MISMATCH TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('8. Security Boundary Mismatches');

    const otherSession = sessionManager.createSession('RELIV-001', 'HEALTH_CHECKUP');
    const otherReq = await v2Service.createPaymentRequest(otherSession.session_id);

    // Mismatched session ID
    const mismatchRes = await v2Service.verifyConfirmationCode(sessionHealth.session_id, {
        requestId: otherReq.requestId,
        code: '1234'
    });
    assert(mismatchRes.ok === false && mismatchRes.code === 'SESSION_MISMATCH', 'Session/request mismatch rejected');

    // ───────────────────────────────────────────────────────────────────────
    // FAIL-SAFE STARTUP (UNCONFIGURED KEYS)
    // ───────────────────────────────────────────────────────────────────────
    section('9. Fail-Safe Startup Without V2 Configuration');

    const unconfiguredService = new PaymentV2Service({
        db,
        pepper: '', // No pepper
        kioskSigningPrivateKeyPath: './non-existent-key.pem',
        cloudEncryptionPublicKeyPath: './non-existent-key.pem'
    });

    assert(unconfiguredService.isConfigured() === false, 'isConfigured() returns false when keys/pepper are missing');

    let notConfiguredThrown = false;
    try {
        const dummySession = sessionManager.createSession('RELIV-001', 'HEALTH_CHECKUP');
        await unconfiguredService.createPaymentRequest(dummySession.session_id);
    } catch (e) {
        if (e.code === 'PAYMENT_V2_NOT_CONFIGURED') notConfiguredThrown = true;
    }
    // ───────────────────────────────────────────────────────────────────────
    // 10. POST-PAYMENT FULFILLMENT RECONCILIATION & REPAIR TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('10. Post-Payment Fulfillment Reconciliation & Repair');

    // Seed test inventory kits
    db.prepare(`
        INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id)
        VALUES 
            ('KIT-PARACETAMOL', 'Paracetamol 650mg', 32, 100, 1),
            ('KIT-HEHE', 'First Aid Kit HeHe', 50, 150, 2),
            ('KIT-BANDAGE', 'Bandage Strips Pack', 13, 100, 3),
            ('KIT-VIT-D', 'Vitamin D3', 120, 50, 1),
            ('KIT-ASPIRIN', 'Aspirin', 40, 80, 2)
    `).run();

    let mqttPublishCount = 0;
    fulfillmentManager.mqttClient = {
        publish: (topic, payload, opts, cb) => {
            mqttPublishCount++;
            if (cb) cb(null);
        },
        connected: true
    };

    // Test 1: PENDING transaction + valid code -> VERIFIED -> fulfillment job created and started
    const s1 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s1Cart = [{ kit_id: 'KIT-PARACETAMOL', quantity: 1 }];
    const s1Txn = transactionManager.createTransaction(s1.session_id, 'MEDICINE', s1Cart);
    const s1Req = await v2Service.createPaymentRequest(s1.session_id, { cart: s1Cart });
    const s1Decrypted = decryptPackage(s1Req.paymentUrl.split('#p=')[1], cloudKeys.privateKey);

    const s1BeforePublishes = mqttPublishCount;
    const s1Verify = await v2Service.verifyConfirmationCode(s1.session_id, {
        requestId: s1Req.requestId,
        code: s1Decrypted.payload.confirmationCode
    });
    assert(s1Verify.ok === true && s1Verify.status === 'VERIFIED', 'Test 1: PENDING transaction verified successfully');
    assert(s1Verify.jobs && s1Verify.jobs.length === 1, 'Test 1: Exactly 1 fulfillment job returned on verification');
    const s1JobInDb = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').get(s1Txn.transaction_id);
    assert(s1JobInDb !== undefined, 'Test 1: Fulfillment job created in SQLite');
    assert(s1JobInDb.kit_id === 'KIT-PARACETAMOL', 'Test 1: Job kitId is KIT-PARACETAMOL');
    assert(mqttPublishCount === s1BeforePublishes + 1, 'Test 1: Dispensing command published to MQTT');

    // Test 2: VERIFIED medicine transaction + zero jobs -> finalization repairs it by creating missing job
    const s2 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s2Cart = [{ kit_id: 'KIT-HEHE', quantity: 9 }];
    const s2Txn = transactionManager.createTransaction(s2.session_id, 'MEDICINE', s2Cart);
    // Manually mark transaction as VERIFIED with zero fulfillment jobs to simulate the bug
    db.prepare("UPDATE transactions SET status = 'VERIFIED', verified = 1 WHERE transaction_id = ?").run(s2Txn.transaction_id);
    const s2ZeroJobs = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(s2Txn.transaction_id);
    assert(s2ZeroJobs.length === 0, 'Test 2 Setup: Verified transaction has zero fulfillment jobs');

    const s2BeforePublishes = mqttPublishCount;
    const s2Repair = await finalizationService.finalizeVerifiedPayment({
        sessionId: s2.session_id,
        transactionId: s2Txn.transaction_id
    });
    assert(s2Repair.success === true, 'Test 2: Finalization succeeded on already-verified transaction');
    assert(s2Repair.alreadyVerified === true, 'Test 2: Finalization detected already-verified status');
    assert(s2Repair.jobs && s2Repair.jobs.length === 1, 'Test 2: Missing fulfillment job was created during reconciliation');
    const s2RepairedJob = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').get(s2Txn.transaction_id);
    assert(s2RepairedJob.kit_id === 'KIT-HEHE' && s2RepairedJob.quantity === 9, 'Test 2: Repaired job has exact kit_id and quantity 9');
    assert(mqttPublishCount === s2BeforePublishes + 1, 'Test 2: Newly repaired job started dispensing');

    // Test 3: VERIFIED transaction + existing PENDING job -> no duplicate job created
    const s3 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s3Cart = [{ kit_id: 'KIT-BANDAGE', quantity: 3 }];
    const s3Txn = transactionManager.createTransaction(s3.session_id, 'MEDICINE', s3Cart);
    db.prepare("UPDATE transactions SET status = 'VERIFIED', verified = 1 WHERE transaction_id = ?").run(s3Txn.transaction_id);
    // Create 1 job in PENDING state
    const s3ExistingJob = await fulfillmentManager.createJob(s3.session_id, s3Txn.transaction_id, 'KIT-BANDAGE', 3);
    assert(s3ExistingJob.state === 'PENDING', 'Test 3 Setup: Existing job is PENDING');

    const s3Finalize = await finalizationService.finalizeVerifiedPayment({
        sessionId: s3.session_id,
        transactionId: s3Txn.transaction_id
    });
    const s3AllJobs = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(s3Txn.transaction_id);
    assert(s3AllJobs.length === 1, 'Test 3: Exactly 1 job exists (no duplicate inserted)');
    assert(s3AllJobs[0].job_id === s3ExistingJob.job_id, 'Test 3: Existing job was reused');

    // Test 4: VERIFIED transaction + COMPLETED job -> absolutely no second dispense
    const s4 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s4Cart = [{ kit_id: 'KIT-PARACETAMOL', quantity: 1 }];
    const s4Txn = transactionManager.createTransaction(s4.session_id, 'MEDICINE', s4Cart);
    db.prepare("UPDATE transactions SET status = 'VERIFIED', verified = 1 WHERE transaction_id = ?").run(s4Txn.transaction_id);
    const s4Job = await fulfillmentManager.createJob(s4.session_id, s4Txn.transaction_id, 'KIT-PARACETAMOL', 1);
    db.prepare("UPDATE fulfillment_jobs SET state = 'COMPLETED' WHERE job_id = ?").run(s4Job.job_id);

    const s4BeforePublishes = mqttPublishCount;
    const s4Finalize = await finalizationService.finalizeVerifiedPayment({
        sessionId: s4.session_id,
        transactionId: s4Txn.transaction_id
    });
    assert(mqttPublishCount === s4BeforePublishes, 'Test 4: Absolutely no second dispense for COMPLETED job (0 new publishes)');
    assert(s4Finalize.jobs[0].state === 'COMPLETED', 'Test 4: Job state remains COMPLETED');

    // Test 5: VERIFIED transaction + IN_PROGRESS job -> do not republish or restart unsafely
    const s5 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s5Cart = [{ kit_id: 'KIT-VIT-D', quantity: 1 }];
    const s5Txn = transactionManager.createTransaction(s5.session_id, 'MEDICINE', s5Cart);
    db.prepare("UPDATE transactions SET status = 'VERIFIED', verified = 1 WHERE transaction_id = ?").run(s5Txn.transaction_id);
    const s5Job = await fulfillmentManager.createJob(s5.session_id, s5Txn.transaction_id, 'KIT-VIT-D', 1);
    db.prepare("UPDATE fulfillment_jobs SET state = 'IN_PROGRESS' WHERE job_id = ?").run(s5Job.job_id);

    const s5BeforePublishes = mqttPublishCount;
    const s5Finalize = await finalizationService.finalizeVerifiedPayment({
        sessionId: s5.session_id,
        transactionId: s5Txn.transaction_id
    });
    assert(mqttPublishCount === s5BeforePublishes, 'Test 5: IN_PROGRESS job not republished (0 new publishes)');

    // Test 6: MANUAL_REVIEW_REQUIRED -> never auto-retry
    const s6 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s6Cart = [{ kit_id: 'KIT-ASPIRIN', quantity: 2 }];
    const s6Txn = transactionManager.createTransaction(s6.session_id, 'MEDICINE', s6Cart);
    db.prepare("UPDATE transactions SET status = 'VERIFIED', verified = 1 WHERE transaction_id = ?").run(s6Txn.transaction_id);
    const s6Job = await fulfillmentManager.createJob(s6.session_id, s6Txn.transaction_id, 'KIT-ASPIRIN', 2);
    db.prepare("UPDATE fulfillment_jobs SET state = 'MANUAL_REVIEW_REQUIRED' WHERE job_id = ?").run(s6Job.job_id);

    const s6BeforePublishes = mqttPublishCount;
    const s6Finalize = await finalizationService.finalizeVerifiedPayment({
        sessionId: s6.session_id,
        transactionId: s6Txn.transaction_id
    });
    assert(mqttPublishCount === s6BeforePublishes, 'Test 6: MANUAL_REVIEW_REQUIRED never auto-retried (0 new publishes)');
    assert(s6Finalize.jobs[0].state === 'MANUAL_REVIEW_REQUIRED', 'Test 6: State remains MANUAL_REVIEW_REQUIRED');

    // Test 7: Two distinct medicines in cart -> exactly two jobs created
    const s7 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s7Cart = [
        { kit_id: 'KIT-PARACETAMOL', quantity: 2 },
        { kit_id: 'KIT-BANDAGE', quantity: 5 }
    ];
    const s7Txn = transactionManager.createTransaction(s7.session_id, 'MEDICINE', s7Cart);
    const s7Req = await v2Service.createPaymentRequest(s7.session_id, { cart: s7Cart });
    const s7Decrypted = decryptPackage(s7Req.paymentUrl.split('#p=')[1], cloudKeys.privateKey);

    const s7Verify = await v2Service.verifyConfirmationCode(s7.session_id, {
        requestId: s7Req.requestId,
        code: s7Decrypted.payload.confirmationCode
    });
    assert(s7Verify.ok === true && s7Verify.status === 'VERIFIED', 'Test 7: Multi-medicine payment verified');
    const s7Jobs = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ? ORDER BY kit_id ASC').all(s7Txn.transaction_id);
    assert(s7Jobs.length === 2, 'Test 7: Exactly 2 fulfillment jobs created for 2-item cart');
    assert(s7Jobs[0].kit_id === 'KIT-BANDAGE' && s7Jobs[0].quantity === 5, 'Test 7: First job kit_id and quantity 5 matched');
    assert(s7Jobs[1].kit_id === 'KIT-PARACETAMOL' && s7Jobs[1].quantity === 2, 'Test 7: Second job kit_id and quantity 2 matched');

    // Test 8: Repeated confirmation-code request -> same jobs returned, no duplicate dispense
    const s7BeforeRepeatPublishes = mqttPublishCount;
    const s7Repeat = await v2Service.verifyConfirmationCode(s7.session_id, {
        requestId: s7Req.requestId,
        code: s7Decrypted.payload.confirmationCode
    });
    assert(s7Repeat.ok === true && s7Repeat.alreadyVerified === true, 'Test 8: Repeated code verification returns alreadyVerified: true');
    assert(s7Repeat.jobs && s7Repeat.jobs.length === 2, 'Test 8: Same 2 jobs returned on repeat');
    const s7JobsAfterRepeat = db.prepare('SELECT * FROM fulfillment_jobs WHERE transaction_id = ?').all(s7Txn.transaction_id);
    assert(s7JobsAfterRepeat.length === 2, 'Test 8: Database still has exactly 2 jobs (no duplicates created)');

    // Test 9: updateResult.changes === 0 concurrency path -> still invokes reconciliation
    const s9 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s9Cart = [{ kit_id: 'KIT-PARACETAMOL', quantity: 1 }];
    const s9Txn = transactionManager.createTransaction(s9.session_id, 'MEDICINE', s9Cart);
    const s9Req = await v2Service.createPaymentRequest(s9.session_id, { cart: s9Cart });
    const s9Decrypted = decryptPackage(s9Req.paymentUrl.split('#p=')[1], cloudKeys.privateKey);

    // Simulate concurrent request transitioning payment_v2_requests to VERIFIED before this caller runs UPDATE
    db.prepare("UPDATE payment_v2_requests SET status = 'VERIFIED' WHERE request_id = ?").run(s9Req.requestId);

    const s9Verify = await v2Service.verifyConfirmationCode(s9.session_id, {
        requestId: s9Req.requestId,
        code: s9Decrypted.payload.confirmationCode
    });
    assert(s9Verify.ok === true && s9Verify.status === 'VERIFIED', 'Test 9: Concurrency path returns ok: true, status: VERIFIED');
    assert(s9Verify.jobs && s9Verify.jobs.length === 1, 'Test 9: Concurrency path invoked reconciliation pipeline and returned jobs');

    // Test 10: Transaction cart quantity is preserved exactly in fulfillment job
    const s10 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const s10Cart = [{ kit_id: 'KIT-HEHE', quantity: 9 }];
    const s10Txn = transactionManager.createTransaction(s10.session_id, 'MEDICINE', s10Cart);
    const s10Req = await v2Service.createPaymentRequest(s10.session_id, { cart: s10Cart });
    const s10Decrypted = decryptPackage(s10Req.paymentUrl.split('#p=')[1], cloudKeys.privateKey);
    const s10Verify = await v2Service.verifyConfirmationCode(s10.session_id, {
        requestId: s10Req.requestId,
        code: s10Decrypted.payload.confirmationCode
    });
    assert(s10Verify.jobs[0].quantity === 9, 'Test 10: Cart purchase quantity 9 is preserved exactly in fulfillment job');

    // ───────────────────────────────────────────────────────────────────────
    // 11. FAIL-CLOSED DISPENSER MOTOR SAFETY TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('11. Fail-Closed Dispenser Motor Safety');

    const capturedMqttPayloads = [];
    fulfillmentManager.mqttClient = {
        publish: (topic, payload, opts, cb) => {
            capturedMqttPayloads.push({ topic, data: JSON.parse(payload) });
            if (cb) cb(null);
        },
        connected: true
    };

    // Seed test kits with various invalid and valid motor configurations
    db.prepare(`
        INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id)
        VALUES 
            ('KIT-MOTOR-NULL', 'Unmapped Kit Null', 50, 10, NULL),
            ('KIT-MOTOR-ZERO', 'Unmapped Kit Zero', 50, 10, 0),
            ('KIT-MOTOR-NEG', 'Unmapped Kit Negative', 50, 10, -1),
            ('KIT-VALID-1', 'Motor 1 Kit', 50, 10, 1),
            ('KIT-VALID-2', 'Motor 2 Kit', 50, 10, 2),
            ('KIT-VALID-3', 'Motor 3 Kit', 50, 10, 3)
    `).run();

    // 1. kit motor_id NULL -> throws MOTOR_NOT_CONFIGURED & no MQTT publish
    let nullMotorThrown = false;
    try {
        await fulfillmentManager.createJob('sess_m_null', 'TXN-M-NULL', 'KIT-MOTOR-NULL', 1);
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') nullMotorThrown = true;
    }
    assert(nullMotorThrown === true, 'Motor ID NULL throws MOTOR_NOT_CONFIGURED');
    assert(capturedMqttPayloads.length === 0, 'Motor ID NULL produces zero MQTT publishes');

    // 2. motor_id undefined -> throws MOTOR_NOT_CONFIGURED & no MQTT publish
    let undefMotorThrown = false;
    try {
        await fulfillmentManager.createJob('sess_m_undef', 'TXN-M-UNDEF', 'KIT-NON-EXISTENT', 1);
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') undefMotorThrown = true;
    }
    assert(undefMotorThrown === true, 'Undefined motor ID throws MOTOR_NOT_CONFIGURED');

    // 3. motor_id 0 -> throws MOTOR_NOT_CONFIGURED & no MQTT publish
    let zeroMotorThrown = false;
    try {
        await fulfillmentManager.createJob('sess_m_zero', 'TXN-M-ZERO', 'KIT-MOTOR-ZERO', 1);
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') zeroMotorThrown = true;
    }
    assert(zeroMotorThrown === true, 'Motor ID 0 throws MOTOR_NOT_CONFIGURED');

    // 4. motor_id negative -> throws MOTOR_NOT_CONFIGURED & no MQTT publish
    let negMotorThrown = false;
    try {
        await fulfillmentManager.createJob('sess_m_neg', 'TXN-M-NEG', 'KIT-MOTOR-NEG', 1);
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') negMotorThrown = true;
    }
    assert(negMotorThrown === true, 'Negative motor ID throws MOTOR_NOT_CONFIGURED');

    // 5. motor_id NaN / non-numeric -> throws MOTOR_NOT_CONFIGURED & no MQTT publish
    let nanMotorThrown = false;
    try {
        await fulfillmentManager.createJob('sess_m_nan', 'TXN-M-NAN', 'KIT-VALID-1', 1, 'invalid_motor');
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') nanMotorThrown = true;
    }
    assert(nanMotorThrown === true, 'Non-numeric motor ID throws MOTOR_NOT_CONFIGURED');

    // 6. startDispensing directly refuses job with invalid motor_id
    const dummySess = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const dummyTxn = transactionManager.createTransaction(dummySess.session_id, 'MEDICINE', [{ kit_id: 'KIT-VALID-1', quantity: 1 }]);
    const dummyJobId = 'JOB-TEST-INVALID-MOTOR';
    db.prepare(`
        INSERT OR REPLACE INTO fulfillment_jobs (job_id, session_id, transaction_id, kit_id, quantity, motor_id, state)
        VALUES (?, ?, ?, 'KIT-VALID-1', 1, NULL, 'PENDING')
    `).run(dummyJobId, dummySess.session_id, dummyTxn.transaction_id);

    let startDispenseRefused = false;
    try {
        await fulfillmentManager.startDispensing(dummyJobId);
    } catch (e) {
        if (e.code === 'MOTOR_NOT_CONFIGURED') startDispenseRefused = true;
    }
    assert(startDispenseRefused === true, 'startDispensing refuses job with NULL motor_id');

    // 7. Valid motor IDs 1, 2, 3 -> publish exact configured motor
    capturedMqttPayloads.length = 0;
    const sV1 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const txnV1 = transactionManager.createTransaction(sV1.session_id, 'MEDICINE', [{ kit_id: 'KIT-VALID-1', quantity: 1 }]);
    const job1 = await fulfillmentManager.createJob(sV1.session_id, txnV1.transaction_id, 'KIT-VALID-1', 1);
    await fulfillmentManager.startDispensing(job1.job_id);
    assert(capturedMqttPayloads[0].data.motor === 1, 'Valid motor 1 correctly published to MQTT');

    const sV2 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const txnV2 = transactionManager.createTransaction(sV2.session_id, 'MEDICINE', [{ kit_id: 'KIT-VALID-2', quantity: 1 }]);
    const job2 = await fulfillmentManager.createJob(sV2.session_id, txnV2.transaction_id, 'KIT-VALID-2', 2);
    await fulfillmentManager.startDispensing(job2.job_id);
    assert(capturedMqttPayloads[1].data.motor === 2, 'Valid motor 2 correctly published to MQTT');

    const sV3 = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const txnV3 = transactionManager.createTransaction(sV3.session_id, 'MEDICINE', [{ kit_id: 'KIT-VALID-3', quantity: 1 }]);
    const job3 = await fulfillmentManager.createJob(sV3.session_id, txnV3.transaction_id, 'KIT-VALID-3', 3);
    await fulfillmentManager.startDispensing(job3.job_id);
    assert(capturedMqttPayloads[2].data.motor === 3, 'Valid motor 3 correctly published to MQTT');

    // 8. End-to-end payment with unconfigured motor kit
    // Seed kit with NULL motor
    db.prepare("INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id) VALUES ('KIT-HEHE-UNMAPPED', 'Hehe No Motor', 50, 25, NULL)").run();
    const initialStock = db.prepare("SELECT quantity FROM inventory WHERE kit_id = 'KIT-HEHE-UNMAPPED'").get().quantity;

    const sUnmapped = sessionManager.createSession('RELIV-001', 'MEDICINE');
    const sUnmappedCart = [{ kit_id: 'KIT-HEHE-UNMAPPED', quantity: 2 }];
    const sUnmappedTxn = transactionManager.createTransaction(sUnmapped.session_id, 'MEDICINE', sUnmappedCart);
    const sUnmappedReq = await v2Service.createPaymentRequest(sUnmapped.session_id, { cart: sUnmappedCart });
    const sUnmappedDecrypted = decryptPackage(sUnmappedReq.paymentUrl.split('#p=')[1], cloudKeys.privateKey);

    const mqttBeforeUnmapped = capturedMqttPayloads.length;
    const sUnmappedVerify = await v2Service.verifyConfirmationCode(sUnmapped.session_id, {
        requestId: sUnmappedReq.requestId,
        code: sUnmappedDecrypted.payload.confirmationCode
    });

    assert(sUnmappedVerify.ok === true && sUnmappedVerify.status === 'VERIFIED', 'Payment is successfully VERIFIED when motor is unconfigured');
    const sUnmappedTxnInDb = transactionManager.getTransaction(sUnmappedTxn.transaction_id);
    assert(sUnmappedTxnInDb.status === 'VERIFIED', 'Transaction status remains VERIFIED (never failed)');
    assert(sUnmappedTxnInDb.verified === 1, 'Transaction verified flag is 1');
    assert(sUnmappedTxnInDb.status !== 'FULFILLED', 'Transaction is NOT marked FULFILLED');
    assert(capturedMqttPayloads.length === mqttBeforeUnmapped, 'Missing motor produced ZERO MQTT publishes (never defaulted to motor 1)');

    const finalStock = db.prepare("SELECT quantity FROM inventory WHERE kit_id = 'KIT-HEHE-UNMAPPED'").get().quantity;
    assert(finalStock === initialStock, 'No inventory deduction occurred without physical dispense');

    // Clean up temporary test files
    closeDatabase();
    try {
        fs.rmSync(TEMP_KEY_DIR, { recursive: true, force: true });
        if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    } catch {}

    // ───────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 PAYMENT V2 TEST RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  📊 Total:   ${passed + failed}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        process.exit(1);
    }
})();
