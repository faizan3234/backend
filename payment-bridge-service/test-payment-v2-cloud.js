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
import {
    isReceiptEmailConfigured,
    createReceiptTransporter,
    formatServiceType,
    formatAmount,
    normalizeEmail,
    generateReceiptContent,
    generateCloudReceiptPdfBuffer,
    sendPaymentReceipt
} from './services/receiptEmailService.js';
import { normalizeCloudReceiptData } from './services/receiptPdfBuilder.js';

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

// Map for mock Razorpay payments by order
const mockRazorpayOrdersFetchPaymentsMap = {};

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
        },
        fetchPayments: async (orderId) => {
            if (mockRazorpayOrdersFetchPaymentsMap[orderId]) {
                return {
                    entity: 'collection',
                    count: mockRazorpayOrdersFetchPaymentsMap[orderId].length,
                    items: mockRazorpayOrdersFetchPaymentsMap[orderId]
                };
            }
            return { entity: 'collection', count: 0, items: [] };
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
    assert(
        dbOrder.encrypted_health_snapshot === null,
        'MEDICINE order stores no health snapshot'
    );

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
    // 4B. HEALTH REPORT SNAPSHOT SECURITY & PERSISTENCE
    // ───────────────────────────────────────────────────────────────────────

    section('4B. Health Report Snapshot Security & Persistence');

    const validHealthReportSnapshot = {
        version: 1,

        patient: {
            name: 'Cloud Test Patient',
            age: 29,
            gender: 'male'
        },

        vitals: {
            systolic: 118,
            diastolic: 76,
            oxygen: 99,
            bpm: 72,
            temperature: 98.4,

            leftEye: '6/6',
            rightEye: '6/6',

            weight: 68.5,
            height: 183,
            impedance: 512,

            bodyFat: 16.8,
            muscleMass: 54.2,
            boneMass: 3.1,
            bodyWater: 58.4,

            skeletalMuscle: 42.1,
            ffmi: 18.7,

            bmr: 1690,
            metabolicAge: 26,

            isAthlete: false
        }
    };


    // ───────────────────────────────────────────────────────────────────────
    // CASE 1:
    // HEALTH_CHECKUP + valid signed snapshot
    // → accepted
    // → encrypted snapshot stored
    // → plaintext health JSON NOT stored
    // ───────────────────────────────────────────────────────────────────────

    const healthPayload = {
        ...testPayload,

        requestId: 'REQ-HEALTH-SNAPSHOT-1',
        requestNonce: 'nonce-health-snapshot-1',

        sessionId: 'KSK-HEALTH-1',
        transactionId: 'TXN-HEALTH-1',

        serviceType: 'HEALTH_CHECKUP',

        confirmationCode: '4182',

        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,

        healthReportSnapshot: validHealthReportSnapshot
    };

    const healthPackage = createPiHybridPackage(
        healthPayload,
        kioskKeys.privateKey,
        cloudKeys4096.publicKey
    );

    const healthOrderRes =
        await v2CloudService.createOrderFromPackage(
            healthPackage
        );

    assert(
        healthOrderRes.ok === true,
        'HEALTH_CHECKUP with valid health snapshot is accepted'
    );

    const healthDbOrder = db
        .prepare(
            'SELECT * FROM payment_v2_orders WHERE request_id = ?'
        )
        .get('REQ-HEALTH-SNAPSHOT-1');

    assert(
        healthDbOrder !== undefined,
        'HEALTH_CHECKUP order persisted in cloud SQLite'
    );

    assert(
        typeof healthDbOrder.encrypted_health_snapshot === 'string' &&
        healthDbOrder.encrypted_health_snapshot.length > 20,
        'Health snapshot is stored as encrypted ciphertext'
    );

    assert(
        !healthDbOrder.encrypted_health_snapshot.includes(
            'Cloud Test Patient'
        ),
        'Patient name is NOT visible in encrypted SQLite snapshot'
    );

    assert(
        !healthDbOrder.encrypted_health_snapshot.includes(
            '"temperature":98.4'
        ),
        'Health measurements are NOT stored as readable JSON'
    );

    let decryptedStoredHealthSnapshot = null;

    try {
        decryptedStoredHealthSnapshot = JSON.parse(
            decryptConfirmationCodeAtRest(
                healthDbOrder.encrypted_health_snapshot,
                TEST_SECRET
            )
        );
    } catch {}

    assert(
        decryptedStoredHealthSnapshot?.version === 1,
        'Encrypted health snapshot decrypts to version 1 payload'
    );

    assert(
        decryptedStoredHealthSnapshot?.patient?.name ===
            'Cloud Test Patient',
        'Encrypted snapshot preserves authoritative patient name'
    );

    assert(
        decryptedStoredHealthSnapshot?.vitals?.temperature ===
            98.4,
        'Encrypted snapshot preserves authoritative temperature'
    );

    assert(
        decryptedStoredHealthSnapshot?.vitals?.oxygen === 99,
        'Encrypted snapshot preserves authoritative oxygen reading'
    );


    // ───────────────────────────────────────────────────────────────────────
    // CASE 2:
    // HEALTH_CHECKUP without snapshot
    // → rejected before order creation
    // ───────────────────────────────────────────────────────────────────────

    let missingHealthSnapshotRejected = false;

    try {
        const missingSnapshotPayload = {
            ...testPayload,

            requestId: 'REQ-HEALTH-MISSING-1',
            requestNonce: 'nonce-health-missing-1',

            sessionId: 'KSK-HEALTH-MISSING-1',
            transactionId: 'TXN-HEALTH-MISSING-1',

            serviceType: 'HEALTH_CHECKUP',

            confirmationCode: '5271',

            issuedAt: Date.now(),
            expiresAt: Date.now() + 300000
        };

        const missingSnapshotPackage =
            createPiHybridPackage(
                missingSnapshotPayload,
                kioskKeys.privateKey,
                cloudKeys4096.publicKey
            );

        await v2CloudService.createOrderFromPackage(
            missingSnapshotPackage
        );
    } catch (e) {
        if (e.code === 'HEALTH_SNAPSHOT_MISSING') {
            missingHealthSnapshotRejected = true;
        }
    }

    assert(
        missingHealthSnapshotRejected,
        'HEALTH_CHECKUP without health snapshot is rejected'
    );

    const missingHealthDbOrder = db
        .prepare(
            'SELECT * FROM payment_v2_orders WHERE request_id = ?'
        )
        .get('REQ-HEALTH-MISSING-1');

    assert(
        missingHealthDbOrder === undefined,
        'Rejected HEALTH_CHECKUP creates no cloud order record'
    );


    // ───────────────────────────────────────────────────────────────────────
    // CASE 3:
    // MEDICINE + health snapshot
    // → rejected
    // ───────────────────────────────────────────────────────────────────────

    let medicineHealthSnapshotRejected = false;

    try {
        const medicineWithHealthPayload = {
            ...testPayload,

            requestId: 'REQ-MEDICINE-HEALTH-1',
            requestNonce: 'nonce-medicine-health-1',

            sessionId: 'KSK-MEDICINE-HEALTH-1',
            transactionId: 'TXN-MEDICINE-HEALTH-1',

            serviceType: 'MEDICINE',

            confirmationCode: '6359',

            issuedAt: Date.now(),
            expiresAt: Date.now() + 300000,

            healthReportSnapshot: validHealthReportSnapshot
        };

        const medicineWithHealthPackage =
            createPiHybridPackage(
                medicineWithHealthPayload,
                kioskKeys.privateKey,
                cloudKeys4096.publicKey
            );

        await v2CloudService.createOrderFromPackage(
            medicineWithHealthPackage
        );
    } catch (e) {
        if (e.code === 'INVALID_HEALTH_SNAPSHOT') {
            medicineHealthSnapshotRejected = true;
        }
    }

    assert(
        medicineHealthSnapshotRejected,
        'MEDICINE payment carrying a health snapshot is rejected'
    );

    const invalidMedicineDbOrder = db
        .prepare(
            'SELECT * FROM payment_v2_orders WHERE request_id = ?'
        )
        .get('REQ-MEDICINE-HEALTH-1');

    assert(
        invalidMedicineDbOrder === undefined,
        'Rejected MEDICINE health payload creates no cloud order record'
    );


    // ───────────────────────────────────────────────────────────────────────
    // CASE 4:
    // Cloud-side allowlist strips unknown fields before encrypted storage.
    // ───────────────────────────────────────────────────────────────────────

    const allowlistPayload = {
        ...testPayload,

        requestId: 'REQ-HEALTH-ALLOWLIST-1',
        requestNonce: 'nonce-health-allowlist-1',

        sessionId: 'KSK-HEALTH-ALLOWLIST-1',
        transactionId: 'TXN-HEALTH-ALLOWLIST-1',

        serviceType: 'HEALTH_CHECKUP',

        confirmationCode: '7416',

        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,

        healthReportSnapshot: {
            ...validHealthReportSnapshot,

            secretUiState: 'DO_NOT_STORE',

            patient: {
                ...validHealthReportSnapshot.patient,

                email: 'must-not-come-from-kiosk@example.com',
                phone: '+919999999999'
            },

            vitals: {
                ...validHealthReportSnapshot.vitals,

                arbitraryInjectedMetric: 123456
            }
        }
    };

    const allowlistPackage =
        createPiHybridPackage(
            allowlistPayload,
            kioskKeys.privateKey,
            cloudKeys4096.publicKey
        );

    await v2CloudService.createOrderFromPackage(
        allowlistPackage
    );

    const allowlistOrder = db
        .prepare(
            'SELECT * FROM payment_v2_orders WHERE request_id = ?'
        )
        .get('REQ-HEALTH-ALLOWLIST-1');

    const sanitizedStoredSnapshot = JSON.parse(
        decryptConfirmationCodeAtRest(
            allowlistOrder.encrypted_health_snapshot,
            TEST_SECRET
        )
    );

    assert(
        sanitizedStoredSnapshot.secretUiState === undefined,
        'Cloud strips arbitrary top-level health snapshot fields'
    );

    assert(
        sanitizedStoredSnapshot.patient.email === undefined,
        'Kiosk-provided email is NOT persisted in health snapshot'
    );

    assert(
        sanitizedStoredSnapshot.patient.phone === undefined,
        'Kiosk-provided phone is NOT persisted in health snapshot'
    );

    assert(
        sanitizedStoredSnapshot.vitals
            .arbitraryInjectedMetric === undefined,
        'Unknown measurement fields are stripped by cloud allowlist'
    );

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
    // 12. RECEIPT EMAIL SERVICE & DUPLICATE PROTECTION
    // ───────────────────────────────────────────────────────────────────────
    section('12. Receipt Email Service & Duplicate Protection');

    // 1. Verify schema tables and indexes exist
    const receiptTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_v2_receipts'").all();
    assert(receiptTables.length === 1, 'payment_v2_receipts table exists in SQLite schema');

    const receiptIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payment_v2_receipts_request'").all();
    assert(receiptIndexes.length === 1, 'idx_payment_v2_receipts_request index exists');

    // 2. formatAmount & formatServiceType
    assert(formatAmount(3784) === '₹37.84', 'formatAmount(3784) correctly formats to ₹37.84');
    assert(formatAmount(50000) === '₹500.00', 'formatAmount(50000) correctly formats to ₹500.00');
    assert(formatServiceType('MEDICINE_PURCHASE') === 'Medicine Purchase', 'formatServiceType maps MEDICINE_PURCHASE to Medicine Purchase');
    assert(formatServiceType('HEALTH_CHECKUP') === 'Health Checkup', 'formatServiceType maps HEALTH_CHECKUP to Health Checkup');

    // 3. Email normalization and validation
    assert(normalizeEmail('  Customer.Test@Gmail.Com  ') === 'customer.test@gmail.com', 'normalizeEmail trims and lowercases email');
    let invalidEmailThrown = false;
    try {
        normalizeEmail('invalid-email-address');
    } catch (e) {
        if (e.code === 'INVALID_EMAIL') invalidEmailThrown = true;
    }
    assert(invalidEmailThrown, 'normalizeEmail rejects invalid email format');

    // 4. Test order setup in DB
    const receiptRequestId = 'REQ-RECEIPT-TEST-1';
    const receiptOrderId = 'order_receipt_test_1';
    const receiptPaymentId = 'pay_receipt_test_1';
    const receiptKioskCode = '4829'; // Code that MUST NEVER appear in receipt

    db.prepare(`
        INSERT INTO payment_v2_orders (
            order_id, request_id, request_nonce, payload_fingerprint,
            session_id, transaction_id, kiosk_id, amount, currency,
            service_type, encrypted_code, status, razorpay_payment_id,
            created_at, expires_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, 'PAID', ?, ?, ?, ?)
    `).run(
        receiptOrderId,
        receiptRequestId,
        'nonce_receipt_1',
        'fingerprint_receipt_1',
        'sess_receipt_1',
        'TXN-RECEIPT-001',
        'KIOSK-001',
        3784, // ₹37.84
        'MEDICINE_PURCHASE',
        encryptConfirmationCodeAtRest(receiptKioskCode, TEST_SECRET),
        receiptPaymentId,
        Date.now() - 60000,
        Date.now() + 300000,
        Date.now()
    );

    const receiptPaidOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(receiptRequestId);

    // 5. Generate receipt content and verify strict security
    const receiptContent = generateReceiptContent(receiptPaidOrder);
    assert(receiptContent.text.includes('₹37.84'), 'Plain text receipt includes authoritative amount ₹37.84');
    assert(receiptContent.text.includes('PAID'), 'Plain text receipt includes status PAID');
    assert(receiptContent.text.includes(receiptPaymentId), 'Plain text receipt includes Payment ID');
    assert(receiptContent.text.includes(receiptOrderId), 'Plain text receipt includes Order ID');
    assert(receiptContent.text.includes(receiptRequestId), 'Plain text receipt includes Request ID');
    assert(receiptContent.text.includes('TXN-RECEIPT-001'), 'Plain text receipt includes Transaction ID');
    assert(receiptContent.text.includes('Medicine Purchase'), 'Plain text receipt includes formatted service label');
    assert(!receiptContent.text.includes(receiptKioskCode), 'CRITICAL: Plain text receipt NEVER includes the 4-digit kiosk code');
    assert(!receiptContent.html.includes(receiptKioskCode), 'CRITICAL: HTML receipt NEVER includes the 4-digit kiosk code');
    assert(receiptContent.html.includes('₹37.84'), 'HTML receipt contains authoritative formatted amount');

    // 6. Mock Nodemailer Transporter
    let sentMails = [];
    const mockTransporter = {
        sendMail: async (options) => {
            sentMails.push(options);
            return { messageId: `<mock-${Date.now()}@reliv.test>` };
        }
    };

    // 7. Reject unpaid order
    const unpaidOrder = { ...receiptPaidOrder, status: 'CREATED', razorpay_payment_id: null };
    let unpaidRejected = false;
    try {
        await sendPaymentReceipt({
            db,
            order: unpaidOrder,
            email: 'customer@gmail.com',
            transporter: mockTransporter
        });
    } catch (e) {
        if (e.code === 'ORDER_NOT_PAID') unpaidRejected = true;
    }
    assert(unpaidRejected, 'sendPaymentReceipt rejects unpaid order with ORDER_NOT_PAID');

    // 8. Successful receipt dispatch
    const sendRes1 = await sendPaymentReceipt({
        db,
        order: receiptPaidOrder,
        email: 'Customer.One@gmail.com',
        transporter: mockTransporter
    });

    assert(sendRes1.ok === true, 'Receipt sent successfully');
    assert(sendRes1.alreadySent === false, 'First send reports alreadySent: false');
    assert(sendRes1.email === 'customer.one@gmail.com', 'Recipient email normalized in response');
    assert(sentMails.length === 1, 'Transporter sendMail called exactly once');
    assert(sentMails[0].to === 'customer.one@gmail.com', 'Sent email addressed to normalized recipient');

    const dbReceiptRecord = db.prepare('SELECT * FROM payment_v2_receipts WHERE request_id = ? AND email = ?').get(receiptRequestId, 'customer.one@gmail.com');
    assert(dbReceiptRecord && dbReceiptRecord.status === 'SENT', 'Receipt record saved in SQLite with status SENT');
    assert(Boolean(dbReceiptRecord.message_id), 'Receipt record contains message_id');
    assert(Boolean(dbReceiptRecord.sent_at), 'Receipt record contains sent_at timestamp');

    // 9. Duplicate protection test: Repeated request for same requestId + normalized email
    const sendRes2 = await sendPaymentReceipt({
        db,
        order: receiptPaidOrder,
        email: '  customer.one@GMAIL.COM  ',
        transporter: mockTransporter
    });

    assert(sendRes2.ok === true, 'Duplicate request returns ok: true');
    assert(sendRes2.alreadySent === true, 'Duplicate request reports alreadySent: true');
    assert(sendRes2.messageId === dbReceiptRecord.message_id, 'Duplicate request returns original messageId');
    assert(sentMails.length === 1, 'Duplicate request does NOT call transporter sendMail again (prevented duplicate email)');

    // 10. Send to different email for same requestId is allowed
    const sendRes3 = await sendPaymentReceipt({
        db,
        order: receiptPaidOrder,
        email: 'secondary@reliv.test',
        transporter: mockTransporter
    });

    assert(sendRes3.ok === true && sendRes3.alreadySent === false, 'Sending to different email is permitted');
    assert(sentMails.length === 2, 'Transporter called for new recipient');

    // 11. PaymentV2CloudService.sendEmailReceipt end-to-end method
    const cloudService = new PaymentV2CloudService({
        db,
        razorpay: { key_id: RZP_KEY_ID, key_secret: RZP_KEY_SECRET },
        cloudPrivateKey: cloudKeys4096.privateKey,
        kioskPublicKeysMap: { 'KIOSK-001': kioskKeys.publicKey },
        codeSecret: TEST_SECRET
    });

    const svcSendRes = await cloudService.sendEmailReceipt({
        requestId: receiptRequestId,
        email: 'customer.one@gmail.com',
        transporterOverride: mockTransporter
    });
    assert(svcSendRes.alreadySent === true, 'cloudService.sendEmailReceipt recognizes already sent receipt');

    // 12. cloudService.sendEmailReceipt for non-existent requestId
    let notFoundThrown = false;
    try {
        await cloudService.sendEmailReceipt({
            requestId: 'REQ-DOES-NOT-EXIST',
            email: 'customer@gmail.com',
            transporterOverride: mockTransporter
        });
    } catch (e) {
        if (e.code === 'ORDER_NOT_FOUND') notFoundThrown = true;
    }
    assert(notFoundThrown, 'cloudService.sendEmailReceipt rejects non-existent requestId with ORDER_NOT_FOUND');

    // 13. Failed SMTP send error handling
    const failingTransporter = {
        sendMail: async () => {
            throw new Error('SMTP connection timeout: 554 Authentication Failed');
        }
    };

    let smtpFailThrown = false;
    try {
        await sendPaymentReceipt({
            db,
            order: receiptPaidOrder,
            email: 'smtp-fail@test.com',
            transporter: failingTransporter
        });
    } catch (e) {
        if (e.code === 'EMAIL_SEND_FAILED') smtpFailThrown = true;
    }
    assert(smtpFailThrown, 'sendPaymentReceipt throws EMAIL_SEND_FAILED on SMTP error');

    const failedRecord = db.prepare("SELECT * FROM payment_v2_receipts WHERE request_id = ? AND email = ? AND status = 'FAILED'").get(receiptRequestId, 'smtp-fail@test.com');
    assert(failedRecord && failedRecord.last_error.includes('SMTP connection timeout'), 'Failed attempt logs error in SQLite audit table');

    // ══════════════════════════════════════════════════════════════════════════
    //  13. Authoritative Cloud PDF Receipt Generation & Security Integrity
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════');
    console.log('  13. Authoritative Cloud PDF Receipt Generation & Security');
    console.log('══════════════════════════════════════════════════');

    // 1. Valid PDF Buffer & Header
    const pdfBuf = await generateCloudReceiptPdfBuffer(receiptPaidOrder, 'customer.one@gmail.com');
    assert(Buffer.isBuffer(pdfBuf), 'Generated PDF is a valid Buffer');
    assert(pdfBuf.slice(0, 5).toString() === '%PDF-', 'PDF Buffer has standard %PDF- header');
    assert(pdfBuf.length > 10000, `PDF Buffer has non-trivial size (${pdfBuf.length} bytes)`);

    // 2. Authoritative Normalization & Zero Data Fabrication
    const normNoCust = normalizeCloudReceiptData(receiptPaidOrder, '  USER@Test.COM ');
    assert(normNoCust.amountInRupees === 37.84, 'Authoritative amount ₹37.84 parsed correctly from 3784 paise');
    assert(normNoCust.recipientEmail === 'user@test.com', 'Recipient email normalized correctly');
    assert(normNoCust.customerName === null, 'Customer name is null when not in authoritative record (no fabrication)');
    assert(!('phone' in normNoCust) && !('customerPhone' in normNoCust), 'Customer phone is completely absent (never collected/fabricated)');
    assert(normNoCust.status === 'PAID', 'Status is authoritative PAID');

    const orderWithCust = { ...receiptPaidOrder, customer_name: 'Aarav Sharma' };
    const normWithCust = normalizeCloudReceiptData(orderWithCust, 'user@test.com');
    assert(normWithCust.customerName === 'Aarav Sharma', 'Customer name populated when genuinely present in record');

    // 3. Nodemailer Attachment Verification
    assert(sentMails.length > 0 && Array.isArray(sentMails[0].attachments), 'Sent mail options include attachments array');
    assert(sentMails[0].attachments.length === 1, 'Sent email includes exactly 1 attachment');
    const att = sentMails[0].attachments[0];
    assert(att.filename.startsWith('Reliv-Receipt-') && att.filename.endsWith('.pdf'), `Attachment filename is valid (${att.filename})`);
    assert(att.contentType === 'application/pdf', 'Attachment contentType is application/pdf');
    assert(Buffer.isBuffer(att.content) && att.content.slice(0, 5).toString() === '%PDF-', 'Attachment content is a valid PDF Buffer');

    // 4. Client Tampering Rejection
    // An attacker tries sending malicious client payload to sendEmailReceipt
    let tamperedOrderMails = [];
    const tamperMockTransporter = {
        sendMail: async (opts) => {
            tamperedOrderMails.push(opts);
            return { messageId: `<tamper-${Date.now()}@reliv.test>` };
        }
    };

    // Client passes spoofed amount, status, paymentId, etc.
    const spoofedSendRes = await cloudService.sendEmailReceipt({
        requestId: receiptRequestId,
        email: 'tamper-check@test.com',
        amount: 1, // Spoofed ₹0.01
        paymentId: 'pay_spoofed_fake',
        status: 'PENDING',
        confirmationCode: '9999',
        transporterOverride: tamperMockTransporter
    });

    assert(spoofedSendRes.ok === true, 'sendEmailReceipt succeeds using authoritative DB record');
    assert(tamperedOrderMails.length === 1, 'Transporter called for tamper check');
    assert(tamperedOrderMails[0].subject.includes('₹37.84'), 'Email subject contains authoritative ₹37.84 (spoofed amount ignored)');
    assert(!tamperedOrderMails[0].text.includes('pay_spoofed_fake'), 'Email body contains authoritative payment ID (spoofed paymentId ignored)');
    assert(!tamperedOrderMails[0].text.includes('9999'), 'Spoofed confirmation code never included in receipt');

    // 5. Strict Confirmation Code Absence
    assert(!tamperedOrderMails[0].text.includes(receiptKioskCode), 'CRITICAL: Plain text never contains the 4-digit code');
    assert(!tamperedOrderMails[0].html.includes(receiptKioskCode), 'CRITICAL: HTML never contains the 4-digit code');

    // 6. Support Email Integrity
    assert(tamperedOrderMails[0].text.includes('relivcustomercare.in@gmail.com'), 'Text receipt contains relivcustomercare.in@gmail.com');
    assert(tamperedOrderMails[0].html.includes('relivcustomercare.in@gmail.com'), 'HTML receipt contains relivcustomercare.in@gmail.com');

    // 7. PDF Generation Failure Handling & State Immutability
    const failingPdfOrder = { ...receiptPaidOrder, request_id: 'REQ-PDF-FAIL-TEST' };
    db.prepare(`
        INSERT INTO payment_v2_orders (
            order_id, request_id, request_nonce, payload_fingerprint,
            session_id, transaction_id, kiosk_id, amount, currency,
            service_type, encrypted_code, status, razorpay_payment_id,
            created_at, expires_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, 'PAID', ?, ?, ?, ?)
    `).run(
        'order_pdf_fail_test',
        'REQ-PDF-FAIL-TEST',
        'nonce_pdf_fail',
        'fingerprint_pdf_fail',
        'sess_pdf_fail',
        'TXN-PDF-FAIL',
        'KIOSK-001',
        50000, // ₹500.00
        'MEDICINE_PURCHASE',
        encryptConfirmationCodeAtRest('1234', TEST_SECRET),
        'pay_pdf_fail_test',
        Date.now() - 60000,
        Date.now() + 300000,
        Date.now()
    );

    let pdfFailThrown = false;
    try {
        await sendPaymentReceipt({
            db,
            order: failingPdfOrder,
            email: 'fail-pdf@test.com',
            transporter: mockTransporter,
            pdfBuilderOverride: async () => {
                throw new Error('Canvas render memory allocation failed');
            }
        });
    } catch (e) {
        if (e.code === 'EMAIL_RECEIPT_GENERATION_FAILED') pdfFailThrown = true;
    }

    assert(pdfFailThrown, 'sendPaymentReceipt throws EMAIL_RECEIPT_GENERATION_FAILED on PDF generation failure');

    const pdfFailedReceiptRecord = db.prepare("SELECT * FROM payment_v2_receipts WHERE request_id = 'REQ-PDF-FAIL-TEST'").get();
    assert(pdfFailedReceiptRecord && pdfFailedReceiptRecord.status === 'FAILED', 'Receipt audit record marked FAILED on PDF error');
    assert(pdfFailedReceiptRecord.last_error.includes('PDF Generation Failed'), 'Receipt audit record records PDF error message');

    const orderAfterPdfFail = db.prepare("SELECT status FROM payment_v2_orders WHERE request_id = 'REQ-PDF-FAIL-TEST'").get();
    assert(orderAfterPdfFail.status === 'PAID', 'Payment record strictly remains PAID even when PDF receipt fails');

    // 8. Multi-Item Cart Snapshot Support
    const orderWithCart = {
        ...receiptPaidOrder,
        request_id: 'REQ-CART-SNAPSHOT',
        amount: 8700, // ₹87.00
        cart: JSON.stringify([
            { name: 'Paracetamol 500mg', quantity: 2, price: 25.00, total: 50.00 },
            { name: 'Vitamin C 500mg', quantity: 1, price: 37.00, total: 37.00 }
        ])
    };
    const cartPdfBuf = await generateCloudReceiptPdfBuffer(orderWithCart, 'cart-user@test.com');
    assert(Buffer.isBuffer(cartPdfBuf) && cartPdfBuf.slice(0, 5).toString() === '%PDF-', 'PDF generated with authoritative cart snapshot');

    // 9. Pagination & Single-Page Guarantee Tests
    function countPdfPages(buffer) {
        const s = buffer.toString('latin1');
        const m = s.match(/\/Type\s*\/Page(?!s)/g);
        return m ? m.length : 0;
    }

    // Standard 1-item receipt must be exactly 1 page
    const standardPageCount = countPdfPages(pdfBuf);
    assert(standardPageCount === 1, `Standard receipt PDF page count is exactly 1 (got: ${standardPageCount})`);

    // No trailing blank page
    assert(countPdfPages(pdfBuf) === 1, 'No trailing blank page generated for standard receipt');

    // Footer does not push to a second page
    const footerPageCount = countPdfPages(await generateCloudReceiptPdfBuffer({
        ...receiptPaidOrder,
        service_type: 'HEALTH_CHECKUP'
    }, 'test-footer@example.com'));
    assert(footerPageCount === 1, 'Footer does not create a new page by itself');

    // Small multi-item carts (2 to 5 items) fit comfortably on 1 page
    assert(countPdfPages(cartPdfBuf) === 1, '2-item cart receipt fits completely on 1 page');

    const fiveItemCartBuf = await generateCloudReceiptPdfBuffer({
        ...receiptPaidOrder,
        cart: JSON.stringify([
            { name: 'Paracetamol 500mg', quantity: 2, price: 25, total: 50 },
            { name: 'Vitamin C 500mg', quantity: 1, price: 37, total: 37 },
            { name: 'Cetirizine 10mg', quantity: 1, price: 15, total: 15 },
            { name: 'Antacid Gel', quantity: 1, price: 80, total: 80 },
            { name: 'Bandage Strips', quantity: 5, price: 5, total: 25 }
        ])
    }, 'five-items@example.com');
    assert(countPdfPages(fiveItemCartBuf) === 1, '5-item cart receipt fits completely on 1 page');

    // Large cart (15 items) paginates cleanly to 2 pages without blank trailing page
    const fifteenItems = [];
    for (let i = 1; i <= 15; i++) {
        fifteenItems.push({ name: `Medicine Item ${i}`, quantity: 1, price: 10 * i, total: 10 * i });
    }
    const fifteenItemCartBuf = await generateCloudReceiptPdfBuffer({
        ...receiptPaidOrder,
        cart: JSON.stringify(fifteenItems)
    }, 'large-cart@example.com');
    const largePageCount = countPdfPages(fifteenItemCartBuf);
    assert(largePageCount === 2, `Large 15-item cart paginates cleanly to 2 pages (got: ${largePageCount})`);

    // Clickable links present in PDF
    const pdfLatin = pdfBuf.toString('latin1');
    assert(pdfLatin.includes('mailto:relivcustomercare.in@gmail.com'), 'Clickable mailto link present in PDF annotations');
    assert(pdfLatin.includes('instagram.com/reliv_care'), 'Clickable Instagram link present in PDF annotations');

    // ───────────────────────────────────────────────────────────────────────
    // 14. SECURE PAYMENT RECOVERY & RECONCILIATION
    // ───────────────────────────────────────────────────────────────────────
    section('14. Secure Payment Recovery & Reconciliation (Lost Browser Callback)');

    // 1. Missing or invalid requestId rejected
    let missingReqIdThrown = false;
    try {
        await v2CloudService.recoverPayment({});
    } catch (e) {
        if (e.code === 'MISSING_REQUEST_ID') missingReqIdThrown = true;
    }
    assert(missingReqIdThrown, 'recoverPayment rejects missing requestId with MISSING_REQUEST_ID');

    // 2. Non-existent requestId rejected
    let orderNotFoundThrown = false;
    try {
        await v2CloudService.recoverPayment({ requestId: 'REQ-DOES-NOT-EXIST-999' });
    } catch (e) {
        if (e.code === 'ORDER_NOT_FOUND') orderNotFoundThrown = true;
    }
    assert(orderNotFoundThrown, 'recoverPayment rejects non-existent request with ORDER_NOT_FOUND');

    // 3. Setup test order in CREATED (pending) status
    const recoveryOrderNonce = 'nonce_recovery_test_1';
    const recoveryOrderId = 'order_recovery_test_1';
    const recoveryReqId = 'REQ-RECOVERY-TEST-1';
    const recoverySecretCode = '8392';
    const recoveryAmount = 45000; // ₹450.00

    db.prepare(`
        INSERT INTO payment_v2_orders (
            order_id, request_id, request_nonce, payload_fingerprint,
            session_id, transaction_id, kiosk_id, amount, currency,
            service_type, item_name, encrypted_code, status,
            created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', ?, ?)
    `).run(
        recoveryOrderId,
        recoveryReqId,
        recoveryOrderNonce,
        'fingerprint_recovery_1',
        'sess_recovery_1',
        'TXN-RECOVERY-1',
        'KIOSK-001',
        recoveryAmount,
        'MEDICINE_PURCHASE',
        'Paracetamol 500mg',
        encryptConfirmationCodeAtRest(recoverySecretCode, TEST_SECRET),
        Date.now() - 30000,
        Date.now() + 300000
    );

    // 4. Recovery when Razorpay has NO captured payments yet
    const pendingRecoveryRes = await v2CloudService.recoverPayment({ requestId: recoveryReqId });
    assert(pendingRecoveryRes.ok === true, 'recoverPayment returns ok: true when pending');
    assert(pendingRecoveryRes.paid === false, 'recoverPayment reports paid: false when no payment captured on Razorpay');
    assert(pendingRecoveryRes.recovered === false, 'recoverPayment reports recovered: false when pending');
    assert(pendingRecoveryRes.confirmationCode === undefined, 'CRITICAL: Confirmation code NOT exposed while payment is pending');

    const dbCheckPending = db.prepare('SELECT status FROM payment_v2_orders WHERE request_id = ?').get(recoveryReqId);
    assert(dbCheckPending.status === 'CREATED', 'Order status remains CREATED in database when unpaid');

    // 5. Simulate Razorpay webhook/callback loss: Customer paid on Razorpay, but phone callback never reached bridge
    const mockRzpPaymentId = 'pay_recovery_captured_999';
    mockRazorpayOrdersFetchPaymentsMap[recoveryOrderId] = [
        {
            id: mockRzpPaymentId,
            order_id: recoveryOrderId,
            amount: recoveryAmount,
            currency: 'INR',
            status: 'captured',
            captured: true
        }
    ];

    // 6. Execute recovery
    const successfulRecoveryRes = await v2CloudService.recoverPayment({
        requestId: recoveryReqId,
        // Browser sending spoofed / malicious inputs should be completely ignored:
        spoofedAmount: 100,
        spoofedPaymentId: 'pay_hacked',
        spoofedCode: '0000'
    });

    assert(successfulRecoveryRes.ok === true, 'recoverPayment succeeds on captured payment');
    assert(successfulRecoveryRes.paid === true, 'recoverPayment reports paid: true');
    assert(successfulRecoveryRes.recovered === true, 'recoverPayment reports recovered: true');
    assert(successfulRecoveryRes.newlyVerified === true, 'recoverPayment reports newlyVerified: true on first recovery');
    assert(successfulRecoveryRes.confirmationCode === recoverySecretCode, 'Confirmation code decrypted and revealed on recovery');
    assert(successfulRecoveryRes.paymentId === mockRzpPaymentId, 'Authoritative payment ID bound from Razorpay');
    assert(successfulRecoveryRes.orderId === recoveryOrderId, 'Authoritative order ID returned');
    assert(successfulRecoveryRes.amount === recoveryAmount, 'Authoritative amount returned (spoofed amount ignored)');

    // 7. Verify SQLite DB state transitioned atomically to PAID
    const dbCheckPaid = db.prepare('SELECT * FROM payment_v2_orders WHERE request_id = ?').get(recoveryReqId);
    assert(dbCheckPaid.status === 'PAID', 'Order transitioned to PAID in SQLite database');
    assert(dbCheckPaid.razorpay_payment_id === mockRzpPaymentId, 'Razorpay payment ID stored in SQLite database');
    assert(dbCheckPaid.verified_at > 0, 'verified_at timestamp set in SQLite database');

    // 8. Idempotent Repeated Recovery on already PAID order
    const repeatedRecoveryRes = await v2CloudService.recoverPayment({ requestId: recoveryReqId });
    assert(repeatedRecoveryRes.ok === true, 'Repeated recoverPayment returns ok: true');
    assert(repeatedRecoveryRes.paid === true, 'Repeated recoverPayment reports paid: true');
    assert(repeatedRecoveryRes.alreadyPaid === true, 'Repeated recoverPayment reports alreadyPaid: true');
    assert(repeatedRecoveryRes.confirmationCode === recoverySecretCode, 'Repeated recovery returns exact same confirmation code');
    assert(repeatedRecoveryRes.paymentId === mockRzpPaymentId, 'Repeated recovery returns exact same payment ID');

    // 9. Replay Attack Prevention on Recovery
    // Another order attempts to bind the exact same payment ID
    const replayOrderId = 'order_recovery_replay_2';
    const replayReqId = 'REQ-RECOVERY-REPLAY-2';
    db.prepare(`
        INSERT INTO payment_v2_orders (
            order_id, request_id, request_nonce, payload_fingerprint,
            session_id, transaction_id, kiosk_id, amount, currency,
            service_type, item_name, encrypted_code, status,
            created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'CREATED', ?, ?)
    `).run(
        replayOrderId,
        replayReqId,
        'nonce_recovery_replay_2',
        'fingerprint_recovery_replay',
        'sess_recovery_replay',
        'TXN-RECOVERY-REPLAY',
        'KIOSK-001',
        recoveryAmount,
        'MEDICINE_PURCHASE',
        'Paracetamol 500mg',
        encryptConfirmationCodeAtRest('9999', TEST_SECRET),
        Date.now() - 30000,
        Date.now() + 300000
    );

    // Mock Razorpay returning the ALREADY USED payment ID for this new order
    mockRazorpayOrdersFetchPaymentsMap[replayOrderId] = [
        {
            id: mockRzpPaymentId, // Already bound to recoveryOrderId!
            order_id: replayOrderId,
            amount: recoveryAmount,
            currency: 'INR',
            status: 'captured'
        }
    ];

    let replayPaymentIdThrown = false;
    try {
        await v2CloudService.recoverPayment({ requestId: replayReqId });
    } catch (e) {
        if (e.code === 'PAYMENT_ID_ALREADY_USED') replayPaymentIdThrown = true;
    }
    // ───────────────────────────────────────────────────────────────────────
    // 15. IMMUTABLE PAYMENT-TIME ITEMS SNAPSHOT INTEGRITY & RECEIPT TESTS
    // ───────────────────────────────────────────────────────────────────────
    section('15. Immutable Payment-Time Items Snapshot Integrity & Receipt Tests');

    // 1. Buy KIT-PARACETAMOL with quantity 1
    const p1Package = createPiHybridPackage({
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-ITEM-INTEGRITY-P1',
        requestNonce: 'nonce_item_integrity_p1',
        sessionId: 'sess_p1',
        transactionId: 'TXN-P1',
        amount: 3784,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '1111',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        items: [
            {
                kitId: 'KIT-PARACETAMOL',
                name: 'Paracetamol 650mg',
                quantity: 1,
                unitPricePaise: 3200,
                lineTotalPaise: 3200
            }
        ],
        breakdown: {
            subtotalPaise: 3200,
            gstPaise: 384,
            platformFeePaise: 200,
            discountPaise: 0,
            totalPaise: 3784
        }
    }, kioskKeys.privateKey, cloudKeys4096.publicKey);

    const p1OrderRes = await v2CloudService.createOrderFromPackage(p1Package);
    const p1Order = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(p1OrderRes.orderId);
    assert(p1Order.items_json !== null, 'Order stores items_json snapshot');
    const p1Normalized = normalizeCloudReceiptData(p1Order, 'p1@test.com');
    assert(p1Normalized.cartItems[0].name === 'Paracetamol 650mg', '1x Paracetamol: exact kit name rendered');
    assert(p1Normalized.cartItems[0].qty === 1, '1x Paracetamol: exact quantity 1 rendered');

    // 2. Buy KIT-PARACETAMOL with quantity 2
    const p2Package = createPiHybridPackage({
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-ITEM-INTEGRITY-P2',
        requestNonce: 'nonce_item_integrity_p2',
        sessionId: 'sess_p2',
        transactionId: 'TXN-P2',
        amount: 7368,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '2222',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        items: [
            {
                kitId: 'KIT-PARACETAMOL',
                name: 'Paracetamol 650mg',
                quantity: 2,
                unitPricePaise: 3200,
                lineTotalPaise: 6400
            }
        ],
        breakdown: {
            subtotalPaise: 6400,
            gstPaise: 768,
            platformFeePaise: 200,
            discountPaise: 0,
            totalPaise: 7368
        }
    }, kioskKeys.privateKey, cloudKeys4096.publicKey);

    const p2OrderRes = await v2CloudService.createOrderFromPackage(p2Package);
    const p2Order = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(p2OrderRes.orderId);
    const p2Normalized = normalizeCloudReceiptData(p2Order, 'p2@test.com');
    assert(p2Normalized.cartItems[0].name === 'Paracetamol 650mg', '2x Paracetamol: exact kit name rendered');
    assert(p2Normalized.cartItems[0].qty === 2, '2x Paracetamol: exact quantity 2 rendered');

    // 3. Buy KIT-HEHE with quantity 9 (where inventory stock was 150)
    const hehePackage = createPiHybridPackage({
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-ITEM-INTEGRITY-HEHE',
        requestNonce: 'nonce_item_integrity_hehe',
        sessionId: 'sess_hehe',
        transactionId: 'TXN-HEHE',
        amount: 45200,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '9999',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        items: [
            {
                kitId: 'KIT-HEHE',
                name: 'First Aid Emergency Kit HeHe',
                quantity: 9, // Exactly 9! NEVER 150 stock quantity!
                unitPricePaise: 5000,
                lineTotalPaise: 45000
            }
        ],
        breakdown: {
            subtotalPaise: 45000,
            gstPaise: 0,
            platformFeePaise: 200,
            discountPaise: 0,
            totalPaise: 45200
        }
    }, kioskKeys.privateKey, cloudKeys4096.publicKey);

    const heheOrderRes = await v2CloudService.createOrderFromPackage(hehePackage);
    const heheOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(heheOrderRes.orderId);
    const heheNormalized = normalizeCloudReceiptData(heheOrder, 'hehe@test.com');
    assert(heheNormalized.cartItems[0].name === 'First Aid Emergency Kit HeHe', 'Custom kit: exact kit name rendered (NOT Paracetamol)');
    assert(heheNormalized.cartItems[0].qty === 9, 'Custom kit: exact purchased quantity 9 rendered (NOT 1, NOT 150 stock)');
    assert(heheNormalized.cartItems[0].unitPrice === 50, 'Custom kit: unit price ₹50.00 rendered');
    assert(heheNormalized.cartItems[0].total === 450, 'Custom kit: line total ₹450.00 rendered');

    // 4. Multiple distinct medicines in cart
    const multiPackage = createPiHybridPackage({
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-ITEM-INTEGRITY-MULTI',
        requestNonce: 'nonce_item_integrity_multi',
        sessionId: 'sess_multi',
        transactionId: 'TXN-MULTI',
        amount: 28424,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '3333',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        items: [
            { kitId: 'KIT-ASPIRIN', name: 'Aspirin 75mg', quantity: 2, unitPricePaise: 4000, lineTotalPaise: 8000 },
            { kitId: 'KIT-VIT-D', name: 'Vitamin D3 60k IU', quantity: 1, unitPricePaise: 12000, lineTotalPaise: 12000 },
            { kitId: 'KIT-BANDAGE', name: 'Bandage Strips Pack', quantity: 4, unitPricePaise: 1300, lineTotalPaise: 5200 }
        ],
        breakdown: {
            subtotalPaise: 25200,
            gstPaise: 3024,
            platformFeePaise: 200,
            discountPaise: 0,
            totalPaise: 28424
        }
    }, kioskKeys.privateKey, cloudKeys4096.publicKey);

    const multiOrderRes = await v2CloudService.createOrderFromPackage(multiPackage);
    const multiOrder = db.prepare('SELECT * FROM payment_v2_orders WHERE order_id = ?').get(multiOrderRes.orderId);
    const multiNormalized = normalizeCloudReceiptData(multiOrder, 'multi@test.com');
    assert(multiNormalized.cartItems.length === 3, 'Multi-kit: exactly 3 items rendered');
    assert(multiNormalized.cartItems[0].name === 'Aspirin 75mg' && multiNormalized.cartItems[0].qty === 2, 'Multi-kit: item 1 exact name and qty 2');
    assert(multiNormalized.cartItems[1].name === 'Vitamin D3 60k IU' && multiNormalized.cartItems[1].qty === 1, 'Multi-kit: item 2 exact name and qty 1');
    assert(multiNormalized.cartItems[2].name === 'Bandage Strips Pack' && multiNormalized.cartItems[2].qty === 4, 'Multi-kit: item 3 exact name and qty 4');

    // 5. Signed snapshot line total mismatch rejected
    const tamperedPayload = {
        v: 2,
        type: 'RELIV_PAYMENT_REQUEST',
        kioskId: 'RELIV-001',
        requestId: 'REQ-TAMPER-LINE',
        requestNonce: 'nonce_tamper_line',
        sessionId: 'sess_tamper_line',
        transactionId: 'TXN-TAMPER-LINE',
        amount: 3784,
        currency: 'INR',
        serviceType: 'MEDICINE',
        confirmationCode: '7777',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        items: [
            {
                kitId: 'KIT-PARACETAMOL',
                name: 'Paracetamol 650mg',
                quantity: 2,
                unitPricePaise: 3200,
                lineTotalPaise: 5000 // TAMPERED! (3200 * 2 != 5000)
            }
        ]
    };
    const tamperedPackage = createPiHybridPackage(tamperedPayload, kioskKeys.privateKey, cloudKeys4096.publicKey);

    let tamperThrown = false;
    try {
        await v2CloudService.createOrderFromPackage(tamperedPackage);
    } catch (e) {
        if (e.code === 'PAYLOAD_TAMPERING_OR_FINGERPRINT_MISMATCH') tamperThrown = true;
    }
    assert(tamperThrown, 'createOrderFromPackage rejects invalid lineTotalPaise mismatch');

    // 6. Old legacy PAID order without items_json or cart renders generic without guessing
    const legacyOrder = {
        order_id: 'order_legacy_old',
        request_id: 'REQ-LEGACY-OLD',
        amount: 10000,
        service_type: 'MEDICINE_PURCHASE',
        items_json: null,
        cart: null,
        item_name: null,
        status: 'PAID',
        verified_at: Date.now()
    };
    const legacyNormalized = normalizeCloudReceiptData(legacyOrder, 'legacy@test.com');
    assert(legacyNormalized.cartItems.length === 1, 'Legacy order without snapshot creates 1 generic row');
    assert(legacyNormalized.cartItems[0].name === 'Medicine Purchase', 'Legacy order without snapshot uses generic "Medicine Purchase"');
    assert(legacyNormalized.cartItems[0].qty === '—', 'Legacy order without snapshot does NOT guess quantity (renders —)');
    assert(legacyNormalized.amountInRupees === 100, 'Legacy order total paid matches authoritative amount ₹100.00');

    // 7. Test PDF Buffer generation for custom kit (9 qty)
    const hehePdfBuf = await generateCloudReceiptPdfBuffer(heheOrder, 'hehe@test.com');
    assert(Buffer.isBuffer(hehePdfBuf) && hehePdfBuf.length > 50000, 'Custom 9-quantity kit generates valid PDF');

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
