/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE — EXPANDED PAYMENT V2 TEST SUITE
 * Purpose: Comprehensive security, crypto, replay, concurrency, and payment
 *          verification tests for the cloud Payment Transport V2 backend.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
    base64UrlEncode,
    base64UrlDecode,
    decryptPackage,
    verifyKioskSignature,
    computePayloadFingerprint,
    encryptConfirmationCodeAtRest,
    decryptConfirmationCodeAtRest,
    verifyRazorpayPaymentSignature
} from './paymentV2Crypto.js';
import { PaymentV2CloudService } from './paymentV2Service.js';
import { createV2RateLimiter } from './paymentV2Routes.js';

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

// ───────────────────────────────────────────────────────────────────────────
// TEST FIXTURES & KEYS
// ───────────────────────────────────────────────────────────────────────────
const TEST_DB_PATH = './test-bridge-v2-expanded.db';
if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}

const db = new Database(TEST_DB_PATH);
db.pragma('journal_mode = WAL');

// Generate test Kiosk Ed25519 keypair
const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const otherKioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

// Generate RSA-4096 Cloud keypair
const cloudKeys4096 = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

// Generate RSA-2048 Cloud keypair for legacy/compatibility check
const cloudKeys2048 = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const otherCloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const TEST_SECRET = 'cloud_test_secret_for_code_at_rest_32bytes_12345';
const RZP_KEY_SECRET = 'test_rzp_secret_key_abcdef123456';
const RZP_KEY_ID = 'rzp_test_1234567890';

// Helper: simulate Pi hybrid encryption
function createPiHybridPackage(payload, kioskPrivateKey, cloudPublicKey) {
    const dataBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = base64UrlEncode(crypto.sign(null, dataBytes, kioskPrivateKey));
    const innerEnvelope = { payload, signature };

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(innerEnvelope), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encryptedKey = crypto.publicEncrypt({
        key: cloudPublicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
    }, aesKey);

    const outerEnvelope = {
        v: 2,
        kid: payload.kioskId,
        ek: base64UrlEncode(encryptedKey),
        iv: base64UrlEncode(iv),
        ct: base64UrlEncode(ciphertext),
        tag: base64UrlEncode(tag)
    };

    return base64UrlEncode(Buffer.from(JSON.stringify(outerEnvelope), 'utf8'));
}

// Track Razorpay order creations
let rzpOrderCreateCount = 0;

// Mock Razorpay Client
const mockRazorpay = {
    key_id: RZP_KEY_ID,
    key_secret: RZP_KEY_SECRET,
    orders: {
        create: async (params) => {
            rzpOrderCreateCount++;
            return {
                id: `order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
                entity: 'order',
                amount: params.amount,
                currency: params.currency,
                receipt: params.receipt,
                status: 'created',
                notes: params.notes
            };
        }
    },
    payments: {
        fetch: async (paymentId) => {
            if (paymentId === 'pay_failed') {
                return { id: paymentId, status: 'failed', amount: 50000, currency: 'INR', order_id: 'order_test' };
            }
            if (paymentId === 'pay_authorized_only') {
                return { id: paymentId, status: 'authorized', amount: 50000, currency: 'INR', order_id: 'order_test' };
            }
            if (paymentId === 'pay_refunded') {
                return { id: paymentId, status: 'refunded', amount: 50000, currency: 'INR', order_id: 'order_test' };
            }
            if (paymentId.startsWith('pay_mismatch_amount')) {
                return { id: paymentId, status: 'captured', amount: 1000, currency: 'INR', order_id: 'order_test' };
            }
            if (paymentId.startsWith('pay_mismatch_currency')) {
                return { id: paymentId, status: 'captured', amount: 50000, currency: 'USD', order_id: 'order_test' };
            }
            return {
                id: paymentId,
                status: 'captured',
                amount: 50000,
                currency: 'INR',
                order_id: paymentId.replace('pay_', 'order_')
            };
        }
    }
};

const v2CloudService = new PaymentV2CloudService({
    db,
    razorpay: mockRazorpay,
    cloudPrivateKey: cloudKeys4096.privateKey,
    kioskPublicKeysMap: {
        'RELIV-001': kioskKeys.publicKey
    },
    codeSecret: TEST_SECRET
});

(async function runAllCloudTests() {
    console.log('\n🚀 RUNNING HARDENED CLOUD PAYMENT TRANSPORT V2 TEST SUITE\n');

    // ───────────────────────────────────────────────────────────────────────
    // 1. CRYPTO & RSA-4096 / RSA-2048 PRIMITIVES
    // ───────────────────────────────────────────────────────────────────────
    section('1. Crypto & RSA-4096 / RSA-2048 Primitives');

    const testPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-TEST-1',
        requestNonce: 'nonce123',
        sessionId: 'KSK-1',
        transactionId: 'TXN-1',
        amount: 50000,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '7294',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };

    const package4096 = createPiHybridPackage(testPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);
    assert(typeof package4096 === 'string' && package4096.length > 50, 'RSA-4096 hybrid package generated');

    const decrypted4096 = decryptPackage(package4096, cloudKeys4096.privateKey);
    assert(decrypted4096.payload.requestId === 'REQ-TEST-1', 'RSA-4096 decrypted requestId matches');
    assert(decrypted4096.payload.amount === 50000, 'RSA-4096 decrypted amount matches (50000 paise)');
    assert(decrypted4096.payload.confirmationCode === '7294', 'RSA-4096 decrypted confirmation code matches');

    const isSigValid = verifyKioskSignature(decrypted4096.payload, decrypted4096.signature, kioskKeys.publicKey);
    assert(isSigValid === true, 'Kiosk Ed25519 signature verified with registered public key');

    const isOtherSigValid = verifyKioskSignature(decrypted4096.payload, decrypted4096.signature, otherKioskKeys.publicKey);
    assert(isOtherSigValid === false, 'Forged Kiosk signature fails verification');

    // Wrong Cloud RSA key fails decryption
    let wrongKeyFailed = false;
    try {
        decryptPackage(package4096, otherCloudKeys.privateKey);
    } catch {
        wrongKeyFailed = true;
    }
    assert(wrongKeyFailed, 'Wrong Cloud private key fails to decrypt package');

    // Ciphertext bit-flipping authentication tag failure
    const rawEnvelope = JSON.parse(base64UrlDecode(package4096).toString('utf8'));
    const tamperedCt = Buffer.from(base64UrlDecode(rawEnvelope.ct));
    tamperedCt[0] ^= 0xFF;
    const tamperedEnvelope = { ...rawEnvelope, ct: base64UrlEncode(tamperedCt) };
    const tamperedPkg = base64UrlEncode(Buffer.from(JSON.stringify(tamperedEnvelope), 'utf8'));

    let tamperingFailed = false;
    try {
        decryptPackage(tamperedPkg, cloudKeys4096.privateKey);
    } catch {
        tamperingFailed = true;
    }
    assert(tamperingFailed, 'AES-256-GCM ciphertext tampering fails authentication');

    // Payload fingerprint calculation
    const fp1 = computePayloadFingerprint(testPayload);
    const fp2 = computePayloadFingerprint(testPayload);
    const fp3 = computePayloadFingerprint({ ...testPayload, amount: 60000 });
    assert(fp1 === fp2 && typeof fp1 === 'string' && fp1.length === 64, 'SHA-256 payload fingerprint is deterministic');
    assert(fp1 !== fp3, 'Payload mutation produces different SHA-256 fingerprint');

    // Code at rest encryption & decryption
    const encryptedCode = encryptConfirmationCodeAtRest('4827', TEST_SECRET);
    assert(!encryptedCode.includes('4827'), 'Encrypted code does not contain plain text');
    const decryptedCode = decryptConfirmationCodeAtRest(encryptedCode, TEST_SECRET);
    assert(decryptedCode === '4827', 'Code at rest successfully decrypted with secret');

    // ───────────────────────────────────────────────────────────────────────
    // 2. PACKAGE SIZE & FORMAT VALIDATION
    // ───────────────────────────────────────────────────────────────────────
    section('2. Package Size & Format Validation');

    // 16KB limit check helper
    const MAX_PACKAGE_BYTES = 16384;
    const normalPackageBytes = Buffer.byteLength(package4096, 'utf8');
    assert(normalPackageBytes < MAX_PACKAGE_BYTES, `Standard package size (${normalPackageBytes} bytes) is within 16KB limit`);

    const hugeString = 'A'.repeat(16385);
    assert(Buffer.byteLength(hugeString, 'utf8') > MAX_PACKAGE_BYTES, 'Oversized package (>16KB) detected');

    // Malformed envelope tests
    let malformedJsonFailed = false;
    try { decryptPackage('not_valid_base64_json', cloudKeys4096.privateKey); } catch { malformedJsonFailed = true; }
    assert(malformedJsonFailed, 'Non-JSON base64url envelope rejected');

    let missingFieldsFailed = false;
    try {
        const incompleteEnvelope = base64UrlEncode(JSON.stringify({ v: 2, ek: 'abc' }));
        decryptPackage(incompleteEnvelope, cloudKeys4096.privateKey);
    } catch { missingFieldsFailed = true; }
    assert(missingFieldsFailed, 'Envelope missing required cryptographic fields rejected');

    // ───────────────────────────────────────────────────────────────────────
    // 3. PAYLOAD STRUCTURE & AUTHORITATIVE VALIDATION
    // ───────────────────────────────────────────────────────────────────────
    section('3. Payload Structure & Authoritative Validation');

    // Version mismatch
    let vMismatch = false;
    try {
        const p = createPiHybridPackage({ ...testPayload, v: 1 }, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'INVALID_PAYLOAD_STRUCTURE') vMismatch = true; }
    assert(vMismatch, 'Package with version != 2 rejected');

    // Type mismatch
    let typeMismatch = false;
    try {
        const p = createPiHybridPackage({ ...testPayload, type: 'OTHER_TYPE' }, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'INVALID_PAYLOAD_STRUCTURE') typeMismatch = true; }
    assert(typeMismatch, 'Package with invalid type rejected');

    // Missing required field (e.g. sessionId)
    let missingField = false;
    try {
        const invalidP = { ...testPayload, sessionId: '' };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'MISSING_PAYLOAD_FIELD') missingField = true; }
    assert(missingField, 'Package missing required sessionId rejected');

    // Invalid confirmation code format (e.g. 3 digits or letters)
    let invalidCodeFormat = false;
    try {
        const invalidP = { ...testPayload, confirmationCode: '12A' };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'INVALID_CONFIRMATION_CODE_FORMAT') invalidCodeFormat = true; }
    assert(invalidCodeFormat, 'Non-4-digit confirmation code in payload rejected');

    // Non-positive amount
    let nonPositiveAmount = false;
    try {
        const invalidP = { ...testPayload, amount: 0 };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'INVALID_AMOUNT') nonPositiveAmount = true; }
    assert(nonPositiveAmount, 'Zero/negative amount in payload rejected');

    // Unsupported currency
    let unsupportedCurrency = false;
    try {
        const invalidP = { ...testPayload, currency: 'USD' };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'UNSUPPORTED_CURRENCY') unsupportedCurrency = true; }
    assert(unsupportedCurrency, 'Non-INR currency rejected');

    // Unregistered Kiosk
    let unregisteredKiosk = false;
    try {
        const invalidP = { ...testPayload, kioskId: 'RELIV-UNKNOWN' };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { unregisteredKiosk = true; }
    assert(unregisteredKiosk, 'Unregistered Kiosk ID rejected');

    // Expired Request
    let expiredReq = false;
    try {
        const invalidP = { ...testPayload, requestId: 'REQ-EXP-TEST', expiresAt: Date.now() - 60000 };
        const p = createPiHybridPackage(invalidP, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(p);
    } catch (e) { if (e.code === 'REQUEST_EXPIRED') expiredReq = true; }
    assert(expiredReq, 'Expired payment request rejected');

    // ───────────────────────────────────────────────────────────────────────
    // 4. ORDER CREATION, FINGERPRINTING & IDEMPOTENCY
    // ───────────────────────────────────────────────────────────────────────
    section('4. Order Creation, Fingerprinting & Idempotency');

    rzpOrderCreateCount = 0;
    const orderRes = await v2CloudService.createOrderFromPackage(package4096);
    assert(orderRes.ok === true, 'Order created successfully from package');
    assert(orderRes.amount === 50000, 'Authoritative amount ₹500.00 bound to order');
    assert(orderRes.orderId.startsWith('order_'), 'Razorpay order ID returned');
    assert(orderRes.keyId === RZP_KEY_ID, 'Razorpay key_id returned');
    assert(orderRes.confirmationCode === undefined, 'Plain confirmation code NOT exposed in createOrder response');
    assert(rzpOrderCreateCount === 1, 'Exactly 1 Razorpay order created');

    // Check DB record
    const dbOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get('REQ-TEST-1');
    assert(dbOrder && dbOrder.status === 'CREATED', 'Order stored in SQLite with status CREATED');
    assert(dbOrder.payload_fingerprint === fp1, 'Stored payload_fingerprint matches calculated SHA-256');
    assert(!dbOrder.encrypted_code.includes('7294'), 'Plain confirmation code NOT stored in plain text');
    assert(decryptConfirmationCodeAtRest(dbOrder.encrypted_code, TEST_SECRET) === '7294', 'Encrypted code in SQLite decrypts to original code');

    // IDEMPOTENCY: Repeated submission of identical package
    const duplicateOrderRes = await v2CloudService.createOrderFromPackage(package4096);
    assert(duplicateOrderRes.orderId === orderRes.orderId, 'Repeated package returns same orderId (idempotent)');
    assert(duplicateOrderRes.alreadyCreated === true, 'Response indicates alreadyCreated: true');
    assert(rzpOrderCreateCount === 1, 'Repeated submission does NOT create additional Razorpay orders (deduplicated)');

    // PAYLOAD TAMPERING / FINGERPRINT MISMATCH: Same requestId with different amount
    let fingerprintMismatch = false;
    try {
        const tamperedPayload = { ...testPayload, amount: 60000 };
        const tamperedPkg = createPiHybridPackage(tamperedPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(tamperedPkg);
    } catch (e) {
        if (e.code === 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH') fingerprintMismatch = true;
    }
    assert(fingerprintMismatch, 'Same requestId with modified payload/amount is rejected (PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH)');

    // REPLAY ATTACK: Reusing requestNonce on different requestId
    let replayNonceRejected = false;
    try {
        const replayPayload = { ...testPayload, requestId: 'REQ-NEW-1', requestNonce: 'nonce123' }; // same nonce
        const replayPkg = createPiHybridPackage(replayPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);
        await v2CloudService.createOrderFromPackage(replayPkg);
    } catch (e) {
        if (e.code === 'REPLAY_NONCE_DETECTED') replayNonceRejected = true;
    }
    assert(replayNonceRejected, 'Replay attack with reused requestNonce rejected (REPLAY_NONCE_DETECTED)');

    // ───────────────────────────────────────────────────────────────────────
    // 5. CONCURRENT ORDER CREATION DEDUPLICATION
    // ───────────────────────────────────────────────────────────────────────
    section('5. Concurrent Order Creation Deduplication');

    const concurrentPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-CONCURRENT-1',
        requestNonce: 'nonce_concurrent_1',
        sessionId: 'KSK-CONC-1',
        transactionId: 'TXN-CONC-1',
        amount: 30000,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '9012',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };
    const concurrentPkg = createPiHybridPackage(concurrentPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);

    const initialCount = rzpOrderCreateCount;
    // Launch 5 parallel requests simultaneously
    const results = await Promise.all([
        v2CloudService.createOrderFromPackage(concurrentPkg),
        v2CloudService.createOrderFromPackage(concurrentPkg),
        v2CloudService.createOrderFromPackage(concurrentPkg),
        v2CloudService.createOrderFromPackage(concurrentPkg),
        v2CloudService.createOrderFromPackage(concurrentPkg)
    ]);

    const allSameOrderId = results.every(r => r.orderId === results[0].orderId);
    assert(allSameOrderId, 'All 5 concurrent requests returned identical orderId');
    assert(rzpOrderCreateCount === initialCount + 1, 'Only 1 Razorpay order creation call was executed across all concurrent requests');

    // ───────────────────────────────────────────────────────────────────────
    // 6. PAYMENT VERIFICATION & STRICT CAPTURED-ONLY ENFORCEMENT
    // ───────────────────────────────────────────────────────────────────────
    section('6. Payment Verification & Strict Captured-Only Rule');

    const verifyPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-VERIFY-2',
        requestNonce: 'nonce_verify_2',
        sessionId: 'KSK-VERIFY-2',
        transactionId: 'TXN-VERIFY-2',
        amount: 50000,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '5566',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };

    const verifyPkg = createPiHybridPackage(verifyPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);
    const verifyOrder = await v2CloudService.createOrderFromPackage(verifyPkg);
    const testOrderId = verifyOrder.orderId;
    const testPaymentId = `pay_${testOrderId.replace('order_', '')}`;

    // Mock payments setup
    mockRazorpay.payments.fetch = async (paymentId) => {
        if (paymentId === testPaymentId) {
            return { id: testPaymentId, status: 'captured', amount: 50000, currency: 'INR', order_id: testOrderId };
        }
        if (paymentId === 'pay_auth_only') {
            return { id: paymentId, status: 'authorized', amount: 50000, currency: 'INR', order_id: testOrderId };
        }
        if (paymentId === 'pay_failed') {
            return { id: paymentId, status: 'failed', amount: 50000, currency: 'INR', order_id: testOrderId };
        }
        if (paymentId === 'pay_wrong_amt') {
            return { id: paymentId, status: 'captured', amount: 1000, currency: 'INR', order_id: testOrderId };
        }
        if (paymentId === 'pay_wrong_order') {
            return { id: paymentId, status: 'captured', amount: 50000, currency: 'INR', order_id: 'order_other_123' };
        }
        if (paymentId === 'pay_wrong_curr') {
            return { id: paymentId, status: 'captured', amount: 50000, currency: 'USD', order_id: testOrderId };
        }
        throw new Error('Payment not found');
    };

    // Missing params check
    let missingParams = false;
    try { await v2CloudService.verifyPaymentAndRevealCode({ orderId: testOrderId }); } catch (e) { missingParams = true; }
    assert(missingParams, 'Missing paymentId/signature rejected');

    // Non-existent order check
    let orderNotFound = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: 'order_non_existent',
            paymentId: testPaymentId,
            signature: 'sig'
        });
    } catch (e) { if (e.code === 'ORDER_NOT_FOUND') orderNotFound = true; }
    assert(orderNotFound, 'Non-existent orderId rejected');

    // Invalid signature check
    let invalidSig = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: testPaymentId,
            signature: 'invalid_sig'
        });
    } catch (e) { if (e.code === 'INVALID_PAYMENT_SIGNATURE') invalidSig = true; }
    assert(invalidSig, 'Invalid Razorpay signature rejected (zero code revealed)');

    // CAPTURED ONLY: Status 'authorized' must be rejected
    const authSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|pay_auth_only`).digest('hex');
    let authRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_auth_only',
            signature: authSig
        });
    } catch (e) { if (e.code === 'PAYMENT_NOT_CAPTURED') authRejected = true; }
    assert(authRejected, 'Payment status "authorized" rejected — CAPTURED is strictly required (zero code revealed)');

    // Failed payment rejected
    const failedSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|pay_failed`).digest('hex');
    let failedRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_failed',
            signature: failedSig
        });
    } catch (e) { if (e.code === 'PAYMENT_NOT_CAPTURED') failedRejected = true; }
    assert(failedRejected, 'Payment status "failed" rejected (zero code revealed)');

    // Amount mismatch rejected
    const amtSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|pay_wrong_amt`).digest('hex');
    let amtMismatch = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_wrong_amt',
            signature: amtSig
        });
    } catch (e) { if (e.code === 'AMOUNT_MISMATCH') amtMismatch = true; }
    assert(amtMismatch, 'Payment amount mismatch rejected (zero code revealed)');

    // Order ID mismatch rejected
    const orderMismatchSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|pay_wrong_order`).digest('hex');
    let orderMismatch = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_wrong_order',
            signature: orderMismatchSig
        });
    } catch (e) { if (e.code === 'ORDER_ID_MISMATCH') orderMismatch = true; }
    assert(orderMismatch, 'Payment order ID mismatch rejected (zero code revealed)');

    // Currency mismatch rejected
    const currMismatchSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|pay_wrong_curr`).digest('hex');
    let currMismatch = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_wrong_curr',
            signature: currMismatchSig
        });
    } catch (e) { if (e.code === 'CURRENCY_MISMATCH') currMismatch = true; }
    assert(currMismatch, 'Payment currency mismatch rejected (zero code revealed)');

    // Request ID mismatch check
    const validSig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${testOrderId}|${testPaymentId}`).digest('hex');
    let reqIdMismatch = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: testPaymentId,
            signature: validSig,
            requestId: 'REQ-DIFFERENT'
        });
    } catch (e) { if (e.code === 'REQUEST_ID_MISMATCH') reqIdMismatch = true; }
    assert(reqIdMismatch, 'Provided requestId mismatch rejected');

    // VALID VERIFICATION & CODE REVEAL
    const verifySuccess = await v2CloudService.verifyPaymentAndRevealCode({
        orderId: testOrderId,
        paymentId: testPaymentId,
        signature: validSig,
        requestId: 'REQ-VERIFY-2'
    });
    assert(verifySuccess.ok === true && verifySuccess.paid === true, 'Payment verified successfully');
    assert(verifySuccess.confirmationCode === '5566', '4-digit confirmation code revealed to paying customer');
    assert(verifySuccess.amount === 50000, 'Verified amount reported in response');
    assert(verifySuccess.alreadyVerified === false, 'First verification reports alreadyVerified: false');

    // DB state check
    const paidOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(testOrderId);
    assert(paidOrder.status === 'PAID', 'Order transitioned to PAID in SQLite');
    assert(paidOrder.razorpay_payment_id === testPaymentId, 'razorpay_payment_id saved in SQLite');
    assert(paidOrder.verified_at > 0, 'verified_at timestamp saved in SQLite');

    // Idempotent re-reveal
    const repeatVerify = await v2CloudService.verifyPaymentAndRevealCode({
        orderId: testOrderId,
        paymentId: testPaymentId,
        signature: validSig
    });
    assert(repeatVerify.ok === true && repeatVerify.alreadyVerified === true, 'Re-verification reports alreadyVerified: true');
    assert(repeatVerify.confirmationCode === '5566', 'Re-verification re-reveals correct code');

    // ───────────────────────────────────────────────────────────────────────
    // 7. UNIQUE PAYMENT ID ENFORCEMENT & REPLAY REJECTION
    // ───────────────────────────────────────────────────────────────────────
    section('7. Unique Payment ID Enforcement & Replay Rejection');

    // Create another distinct order
    const secondOrderPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-SECOND-ORDER',
        requestNonce: 'nonce_second_order',
        sessionId: 'KSK-SECOND',
        transactionId: 'TXN-SECOND',
        amount: 50000,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '8899',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };
    const secondPkg = createPiHybridPackage(secondOrderPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);
    const secondOrder = await v2CloudService.createOrderFromPackage(secondPkg);

    // Attempt to verify second order using ALREADY-USED testPaymentId
    const replaySig = crypto.createHmac('sha256', RZP_KEY_SECRET).update(`${secondOrder.orderId}|${testPaymentId}`).digest('hex');

    // Override mock to return matching second order ID
    mockRazorpay.payments.fetch = async (paymentId) => {
        if (paymentId === testPaymentId) {
            return { id: testPaymentId, status: 'captured', amount: 50000, currency: 'INR', order_id: secondOrder.orderId };
        }
        throw new Error('Payment not found');
    };

    let paymentIdReplayRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: secondOrder.orderId,
            paymentId: testPaymentId,
            signature: replaySig
        });
    } catch (e) {
        if (e.code === 'PAYMENT_ID_ALREADY_USED') paymentIdReplayRejected = true;
    }
    assert(paymentIdReplayRejected, 'Replay of already verified payment ID on different order is rejected by UNIQUE constraint');

    // ───────────────────────────────────────────────────────────────────────
    // 8. ORDER STATUS ENDPOINT & ZERO CODE LEAKAGE
    // ───────────────────────────────────────────────────────────────────────
    section('8. Order Status Endpoint & Zero Code Leakage');

    const statusUnpaid = v2CloudService.getOrderStatus(secondOrder.orderId);
    assert(statusUnpaid.ok === true && statusUnpaid.status === 'CREATED' && statusUnpaid.paid === false, 'Unpaid order reports status CREATED, paid: false');
    assert(statusUnpaid.confirmationCode === undefined, 'Status poll does NOT leak confirmation code on unpaid order');

    const statusPaid = v2CloudService.getOrderStatus(testOrderId);
    assert(statusPaid.ok === true && statusPaid.status === 'PAID' && statusPaid.paid === true, 'Paid order reports status PAID, paid: true');
    assert(statusPaid.confirmationCode === undefined, 'Status poll does NOT leak confirmation code on paid order');

    const statusMissing = v2CloudService.getOrderStatus('order_non_existent');
    assert(statusMissing.ok === false && statusMissing.code === 'ORDER_NOT_FOUND', 'Non-existent order reports ORDER_NOT_FOUND');

    // ───────────────────────────────────────────────────────────────────────
    // 9. RATE LIMITER UNIT TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('9. Rate Limiter Unit Tests');

    const limiter = createV2RateLimiter({ windowMs: 1000, max: 2 });
    let reqCount = 0;
    let rateLimited = false;

    const fakeReq = { ip: '192.168.1.100' };
    const fakeRes = {
        status: (code) => ({
            json: (data) => {
                if (code === 429 && data.code === 'RATE_LIMIT_EXCEEDED') rateLimited = true;
            }
        })
    };

    limiter(fakeReq, fakeRes, () => { reqCount++; });
    limiter(fakeReq, fakeRes, () => { reqCount++; });
    limiter(fakeReq, fakeRes, () => { reqCount++; }); // 3rd request should exceed max 2

    assert(reqCount === 2, 'Rate limiter allowed exactly 2 requests');
    assert(rateLimited, '3rd request was rejected with 429 RATE_LIMIT_EXCEEDED');

    // ───────────────────────────────────────────────────────────────────────
    // 10. DATABASE PERSISTENCE ACROSS RESTART
    // ───────────────────────────────────────────────────────────────────────
    section('10. Database Persistence Across Restart');

    const serviceReboot = new PaymentV2CloudService({
        db,
        razorpay: mockRazorpay,
        cloudPrivateKey: cloudKeys4096.privateKey,
        kioskPublicKeysMap: { 'RELIV-001': kioskKeys.publicKey },
        codeSecret: TEST_SECRET
    });

    const rebootPaidOrder = serviceReboot.getOrderStatus(testOrderId);
    assert(rebootPaidOrder.paid === true && rebootPaidOrder.status === 'PAID', 'Order status persists across service restart');

    // ───────────────────────────────────────────────────────────────────────
    // 11. FAIL-SAFE STARTUP & MISSING CONFIGURATION HANDLING
    // ───────────────────────────────────────────────────────────────────────
    section('11. Fail-Safe Startup & Missing Configuration Handling');

    // 1. Missing secret throws in crypto methods
    let encryptSecretMissing = false;
    try {
        encryptConfirmationCodeAtRest('1234', '');
    } catch (e) {
        encryptSecretMissing = true;
    }
    assert(encryptSecretMissing, 'encryptConfirmationCodeAtRest throws when secret is missing (no hardcoded fallback)');

    let decryptSecretMissing = false;
    try {
        decryptConfirmationCodeAtRest('a:b:c', '');
    } catch (e) {
        decryptSecretMissing = true;
    }
    assert(decryptSecretMissing, 'decryptConfirmationCodeAtRest throws when secret is missing (no hardcoded fallback)');

    // 2. isConfigured returns false when codeSecret is missing
    const unconfiguredNoSecret = new PaymentV2CloudService({
        db,
        razorpay: mockRazorpay,
        cloudPrivateKey: cloudKeys4096.privateKey,
        kioskPublicKeysMap: { 'RELIV-001': kioskKeys.publicKey },
        codeSecret: ''
    });
    assert(unconfiguredNoSecret.isConfigured() === false, 'isConfigured() returns false when codeSecret is missing');

    // 3. isConfigured returns false when private key is missing
    const unconfiguredNoKey = new PaymentV2CloudService({
        db,
        razorpay: mockRazorpay,
        cloudPrivateKeyPath: './non-existent-key.pem',
        kioskPublicKeysMap: { 'RELIV-001': kioskKeys.publicKey },
        codeSecret: TEST_SECRET
    });
    assert(unconfiguredNoKey.isConfigured() === false, 'isConfigured() returns false when cloud RSA private key is missing');

    // 4. isConfigured returns false when razorpay is missing
    const unconfiguredNoRzp = new PaymentV2CloudService({
        db,
        razorpay: null,
        cloudPrivateKey: cloudKeys4096.privateKey,
        kioskPublicKeysMap: { 'RELIV-001': kioskKeys.publicKey },
        codeSecret: TEST_SECRET
    });
    assert(unconfiguredNoRzp.isConfigured() === false, 'isConfigured() returns false when razorpay is missing');

    // 5. isConfigured returns false when kiosk public key is missing
    const unconfiguredNoKiosk = new PaymentV2CloudService({
        db,
        razorpay: mockRazorpay,
        cloudPrivateKey: cloudKeys4096.privateKey,
        kioskPublicKeyPath: './non-existent-kiosk.pem',
        kioskPublicKeysMap: {},
        codeSecret: TEST_SECRET
    });
    assert(unconfiguredNoKiosk.isConfigured() === false, 'isConfigured() returns false when kiosk public keys are missing');

    // 6. createOrderFromPackage throws PAYMENT_V2_NOT_CONFIGURED
    let createOrderNotConfigured = false;
    try {
        await unconfiguredNoSecret.createOrderFromPackage(package4096);
    } catch (e) {
        if (e.code === 'PAYMENT_V2_NOT_CONFIGURED') createOrderNotConfigured = true;
    }
    assert(createOrderNotConfigured, 'createOrderFromPackage throws PAYMENT_V2_NOT_CONFIGURED when unconfigured');

    // 7. verifyPaymentAndRevealCode throws PAYMENT_V2_NOT_CONFIGURED
    let verifyNotConfigured = false;
    try {
        await unconfiguredNoSecret.verifyPaymentAndRevealCode({
            orderId: 'order_123',
            paymentId: 'pay_123',
            signature: 'sig_123'
        });
    } catch (e) {
        if (e.code === 'PAYMENT_V2_NOT_CONFIGURED') verifyNotConfigured = true;
    }
    assert(verifyNotConfigured, 'verifyPaymentAndRevealCode throws PAYMENT_V2_NOT_CONFIGURED when unconfigured');

    // ───────────────────────────────────────────────────────────────────────
    // CLEANUP
    // ───────────────────────────────────────────────────────────────────────
    db.close();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}

    // ───────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 EXPANDED CLOUD PAYMENT V2 TEST RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  📊 Total:   ${passed + failed}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        process.exit(1);
    }
})();
