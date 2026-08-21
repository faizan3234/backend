/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV CLOUD PAYMENT BRIDGE — PAYMENT V2 AUTOMATED TEST SUITE
 * Purpose: Comprehensive security, crypto, and payment verification tests
 *          for the cloud Payment Transport V2 backend.
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
    encryptConfirmationCodeAtRest,
    decryptConfirmationCodeAtRest,
    verifyRazorpayPaymentSignature
} from './paymentV2Crypto.js';
import { PaymentV2CloudService } from './paymentV2Service.js';

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
const TEST_DB_PATH = './test-bridge-v2.db';
if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}

const db = new Database(TEST_DB_PATH);
db.pragma('journal_mode = WAL');

// Generate test Kiosk Ed25519 keypair (simulating Pi)
const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const otherKioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

// Generate test Cloud RSA keypair
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

// Mock Razorpay Client
const mockRazorpay = {
    key_id: RZP_KEY_ID,
    key_secret: RZP_KEY_SECRET,
    orders: {
        create: async (params) => {
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
            // Default mock payment
            if (paymentId === 'pay_failed') {
                return { id: paymentId, status: 'failed', amount: 50000, currency: 'INR', order_id: 'order_test' };
            }
            if (paymentId.startsWith('pay_mismatch_amount')) {
                return { id: paymentId, status: 'captured', amount: 1000, currency: 'INR', order_id: 'order_test' };
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
    cloudPrivateKey: cloudKeys.privateKey,
    kioskPublicKeysMap: {
        'RELIV-001': kioskKeys.publicKey
    },
    codeSecret: TEST_SECRET
});

(async function runAllCloudTests() {
    console.log('\n🚀 RUNNING CLOUD PAYMENT TRANSPORT V2 TEST SUITE\n');

    // ───────────────────────────────────────────────────────────────────────
    // 1. CRYPTO & DECRYPTION PRIMITIVES
    // ───────────────────────────────────────────────────────────────────────
    section('1. Crypto & Decryption Primitives');

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

    const packageStr = createPiHybridPackage(testPayload, kioskKeys.privateKey, cloudKeys.publicKey);
    assert(typeof packageStr === 'string' && packageStr.length > 50, 'Pi hybrid package generated');

    const decrypted = decryptPackage(packageStr, cloudKeys.privateKey);
    assert(decrypted.payload.requestId === 'REQ-TEST-1', 'Decrypted payload matches original requestId');
    assert(decrypted.payload.amount === 50000, 'Decrypted payload matches original amount (50000 paise)');
    assert(decrypted.payload.confirmationCode === '7294', 'Decrypted payload matches confirmation code');

    const isSigValid = verifyKioskSignature(decrypted.payload, decrypted.signature, kioskKeys.publicKey);
    assert(isSigValid === true, 'Kiosk Ed25519 signature verified with registered public key');

    const isOtherSigValid = verifyKioskSignature(decrypted.payload, decrypted.signature, otherKioskKeys.publicKey);
    assert(isOtherSigValid === false, 'Forged Kiosk signature fails verification');

    // Wrong Cloud RSA key fails decryption
    let wrongKeyFailed = false;
    try {
        decryptPackage(packageStr, otherCloudKeys.privateKey);
    } catch {
        wrongKeyFailed = true;
    }
    assert(wrongKeyFailed, 'Wrong Cloud private key cannot decrypt package');

    // Code at rest encryption & decryption
    const encryptedCode = encryptConfirmationCodeAtRest('4827', TEST_SECRET);
    assert(!encryptedCode.includes('4827'), 'Encrypted code does not contain plain text');
    const decryptedCode = decryptConfirmationCodeAtRest(encryptedCode, TEST_SECRET);
    assert(decryptedCode === '4827', 'Code at rest successfully decrypted with secret');

    // ───────────────────────────────────────────────────────────────────────
    // 2. ORDER CREATION FROM PACKAGE (/v2/create-order)
    // ───────────────────────────────────────────────────────────────────────
    section('2. Order Creation (/v2/create-order)');

    const orderRes = await v2CloudService.createOrderFromPackage(packageStr);
    assert(orderRes.ok === true, 'Order created successfully from package');
    assert(orderRes.amount === 50000, 'Authoritative amount ₹500.00 bound to order');
    assert(orderRes.orderId.startsWith('order_'), 'Razorpay order ID returned');
    assert(orderRes.keyId === RZP_KEY_ID, 'Razorpay key_id returned');
    assert(orderRes.confirmationCode === undefined, 'Plain confirmation code is NOT exposed in createOrder response');

    // Verify DB does not contain plain code in database
    const dbOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get('REQ-TEST-1');
    assert(dbOrder && dbOrder.status === 'CREATED', 'Order stored in SQLite with status CREATED');
    assert(!dbOrder.encrypted_code.includes('7294'), 'Plain confirmation code is NOT stored in plain text in SQLite');
    assert(decryptConfirmationCodeAtRest(dbOrder.encrypted_code, TEST_SECRET) === '7294', 'Encrypted code in SQLite decrypts to original code');

    // IDEMPOTENCY: Re-submitting identical package returns same orderId
    const duplicateOrderRes = await v2CloudService.createOrderFromPackage(packageStr);
    assert(duplicateOrderRes.orderId === orderRes.orderId, 'Repeated package submission returns same orderId (idempotent)');

    // REPLAY ATTACK: Re-using same requestNonce with different requestId is rejected
    const replayPayload = { ...testPayload, requestId: 'REQ-TEST-REPLAY' };
    const replayPkg = createPiHybridPackage(replayPayload, kioskKeys.privateKey, cloudKeys.publicKey);

    let replayRejected = false;
    try {
        await v2CloudService.createOrderFromPackage(replayPkg);
    } catch (e) {
        if (e.code === 'REPLAY_NONCE_DETECTED') replayRejected = true;
    }
    assert(replayRejected, 'Replay attack with reused nonce is rejected');

    // EXPIRED REQUEST REJECTION
    const expiredPayload = {
        ...testPayload,
        requestId: 'REQ-EXPIRED-1',
        requestNonce: 'nonce_exp_1',
        expiresAt: Date.now() - 60000 // Expired 1 minute ago
    };
    const expiredPkg = createPiHybridPackage(expiredPayload, kioskKeys.privateKey, cloudKeys.publicKey);

    let expiredRejected = false;
    try {
        await v2CloudService.createOrderFromPackage(expiredPkg);
    } catch (e) {
        if (e.code === 'REQUEST_EXPIRED') expiredRejected = true;
    }
    assert(expiredRejected, 'Expired payment package is rejected');

    // ───────────────────────────────────────────────────────────────────────
    // 3. PAYMENT VERIFICATION & CODE REVEAL (/v2/verify-payment)
    // ───────────────────────────────────────────────────────────────────────
    section('3. Payment Verification & Code Reveal (/v2/verify-payment)');

    // Create fresh package & order for verification test
    const verifyTestPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-VERIFY-1',
        requestNonce: 'nonce_verify_1',
        sessionId: 'KSK-VERIFY-1',
        transactionId: 'TXN-VERIFY-1',
        amount: 50000,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '3189',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000
    };

    const verifyPkg = createPiHybridPackage(verifyTestPayload, kioskKeys.privateKey, cloudKeys.publicKey);
    const verifyOrder = await v2CloudService.createOrderFromPackage(verifyPkg);

    const testOrderId = verifyOrder.orderId;
    const testPaymentId = `pay_${testOrderId.replace('order_', '')}`;

    // Override mock payment fetch to return matching order & amount
    mockRazorpay.payments.fetch = async (paymentId) => {
        if (paymentId === testPaymentId) {
            return {
                id: testPaymentId,
                status: 'captured',
                amount: 50000,
                currency: 'INR',
                order_id: testOrderId
            };
        }
        if (paymentId === 'pay_wrong_amount') {
            return {
                id: paymentId,
                status: 'captured',
                amount: 1000, // ₹10.00 instead of ₹500.00
                currency: 'INR',
                order_id: testOrderId
            };
        }
        if (paymentId === 'pay_not_captured') {
            return {
                id: paymentId,
                status: 'failed',
                amount: 50000,
                currency: 'INR',
                order_id: testOrderId
            };
        }
        throw new Error('Payment not found');
    };

    // 1. Invalid Razorpay Signature Rejection
    let invalidSigRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: testPaymentId,
            signature: 'fake_invalid_signature_12345'
        });
    } catch (e) {
        if (e.code === 'INVALID_PAYMENT_SIGNATURE') invalidSigRejected = true;
    }
    assert(invalidSigRejected, 'Invalid Razorpay signature rejected (zero code revealed)');

    // 2. Amount Mismatch Rejection
    const mismatchSig = crypto
        .createHmac('sha256', RZP_KEY_SECRET)
        .update(`${testOrderId}|pay_wrong_amount`)
        .digest('hex');

    let mismatchRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_wrong_amount',
            signature: mismatchSig
        });
    } catch (e) {
        if (e.code === 'AMOUNT_MISMATCH') mismatchRejected = true;
    }
    assert(mismatchRejected, 'Payment amount mismatch rejected (zero code revealed)');

    // 3. Failed/Uncaptured Payment Rejection
    const uncapturedSig = crypto
        .createHmac('sha256', RZP_KEY_SECRET)
        .update(`${testOrderId}|pay_not_captured`)
        .digest('hex');

    let uncapturedRejected = false;
    try {
        await v2CloudService.verifyPaymentAndRevealCode({
            orderId: testOrderId,
            paymentId: 'pay_not_captured',
            signature: uncapturedSig
        });
    } catch (e) {
        if (e.code === 'PAYMENT_NOT_CAPTURED') uncapturedRejected = true;
    }
    assert(uncapturedRejected, 'Uncaptured payment rejected (zero code revealed)');

    // 4. Valid Payment Verification & Code Reveal
    const validSig = crypto
        .createHmac('sha256', RZP_KEY_SECRET)
        .update(`${testOrderId}|${testPaymentId}`)
        .digest('hex');

    const verifySuccess = await v2CloudService.verifyPaymentAndRevealCode({
        orderId: testOrderId,
        paymentId: testPaymentId,
        signature: validSig
    });

    assert(verifySuccess.ok === true && verifySuccess.paid === true, 'Payment verified successfully');
    assert(verifySuccess.confirmationCode === '3189', '4-digit confirmation code revealed to paying customer');
    assert(verifySuccess.amount === 50000, 'Verified amount reported in response');

    // Check DB status updated to PAID
    const paidDbOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(testOrderId);
    assert(paidDbOrder.status === 'PAID', 'Order status transitioned to PAID in SQLite');
    assert(paidDbOrder.razorpay_payment_id === testPaymentId, 'Razorpay payment ID recorded in order');

    // 5. Idempotent Code Reveal for Already Paid Order
    const repeatVerify = await v2CloudService.verifyPaymentAndRevealCode({
        orderId: testOrderId,
        paymentId: testPaymentId,
        signature: validSig
    });
    assert(repeatVerify.ok === true && repeatVerify.alreadyVerified === true, 'Repeated verification is idempotent (alreadyVerified: true)');
    assert(repeatVerify.confirmationCode === '3189', 'Confirmation code re-revealed on repeat submission');

    // ───────────────────────────────────────────────────────────────────────
    // CLEANUP
    // ───────────────────────────────────────────────────────────────────────
    db.close();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}

    // ───────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 CLOUD PAYMENT V2 TEST RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  📊 Total:   ${passed + failed}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    if (failed > 0) {
        process.exit(1);
    }
})();
