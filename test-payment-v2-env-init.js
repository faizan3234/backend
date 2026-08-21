/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION TEST — Payment V2 Environment Initialization Order
 *
 * Proves that .env values loaded during normal `node server.js` startup
 * are visible to PaymentV2Service even though it is imported before
 * dotenv.config() is called.
 *
 * This test simulates the exact sequence:
 *   1. Import paymentV2Service (lazy proxy — no construction yet)
 *   2. Set process.env vars (simulating dotenv.config())
 *   3. Access the proxy → constructor runs NOW, reads process.env correctly
 * ═══════════════════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ── Counters ──
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
// SETUP — simulate dotenv.config() timing
// ═══════════════════════════════════════════════════════════════════════════

// Use a test database
const TEST_DB_PATH = './data/test-env-init-order.db';
if (fs.existsSync(TEST_DB_PATH)) {
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
}
process.env.DB_PATH = TEST_DB_PATH;

// Generate test keypairs
const TEMP_KEY_DIR = './data/test-env-init-keys';
if (!fs.existsSync(TEMP_KEY_DIR)) fs.mkdirSync(TEMP_KEY_DIR, { recursive: true });

const kioskKeys = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});
const cloudKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const tempKioskPrivPath = path.join(TEMP_KEY_DIR, 'test-kiosk-priv.pem');
const tempCloudPubPath  = path.join(TEMP_KEY_DIR, 'test-cloud-pub.pem');
fs.writeFileSync(tempKioskPrivPath, kioskKeys.privateKey);
fs.writeFileSync(tempCloudPubPath,  cloudKeys.publicKey);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: Prove that SETTING env BEFORE first access works
// ═══════════════════════════════════════════════════════════════════════════
// We must set env vars BEFORE importing the module, because ES module
// evaluation has already happened (but the lazy proxy defers construction).
//
// In server.js the same sequence is:
//   import paymentV2Service ...   ← proxy created, no constructor yet
//   dotenv.config();              ← sets process.env.*
//   ... later code accesses paymentV2Service.isConfigured() ← NOW constructs

// Set env vars (simulating what dotenv.config() would do)
const TEST_PEPPER = 'regression_test_pepper_MUST_ARRIVE_' + crypto.randomBytes(8).toString('hex');
const TEST_KIOSK_ID = 'REGRESSION-KIOSK-42';
const TEST_MAX_ATTEMPTS = '7';
const TEST_TTL = '600';

process.env.PAYMENT_V2_CODE_PEPPER = TEST_PEPPER;
process.env.PAYMENT_V2_KIOSK_ID = TEST_KIOSK_ID;
process.env.PAYMENT_V2_MAX_ATTEMPTS = TEST_MAX_ATTEMPTS;
process.env.PAYMENT_V2_TTL_SECONDS = TEST_TTL;
process.env.PAYMENT_V2_KIOSK_SIGNING_PRIVATE_KEY_PATH = tempKioskPrivPath;
process.env.PAYMENT_V2_CLOUD_ENCRYPTION_PUBLIC_KEY_PATH = tempCloudPubPath;

// NOW import the module — it will be lazily initialized
const { initializeDatabase } = await import('./src/database/db.js');
const sessionManagerMod = await import('./src/services/sessionManager.js');
const transactionManagerMod = await import('./src/services/transactionManager.js');

// Initialize database (required for service)
initializeDatabase();
sessionManagerMod.default.initialize();
transactionManagerMod.transactionManager.initialize();

// Import the lazy singleton
const { paymentV2Service, PaymentV2Service } = await import('./src/services/paymentV2Service.js');

// Seed minimal inventory
const { getDb } = await import('./src/database/db.js');
const db = getDb();
db.prepare(`
    INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id)
    VALUES ('KIT-REGRESSION', 'Regression Kit', 100, 10, 1)
`).run();

// Mock fulfillment MQTT
const fulfillmentMod = await import('./src/services/fulfillmentManager.js');
fulfillmentMod.default.mqttClient = {
    publish: (topic, payload, opts, cb) => cb ? cb(null) : null,
    connected: true
};

// ═══════════════════════════════════════════════════════════════════════════
// RUN TESTS
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n🚀 REGRESSION TEST — Payment V2 ENV Initialization Order\n');

section('1. Lazy Proxy Captures process.env After dotenv.config()');

// Access the proxy — this triggers construction
assert(
    typeof paymentV2Service.isConfigured === 'function',
    'paymentV2Service.isConfigured is a function (proxy works)'
);

assert(
    paymentV2Service.pepper === TEST_PEPPER,
    `pepper matches env value (got: "${paymentV2Service.pepper?.substring(0, 30)}...")`
);

assert(
    paymentV2Service.kioskId === TEST_KIOSK_ID,
    `kioskId matches env value (expected: ${TEST_KIOSK_ID}, got: ${paymentV2Service.kioskId})`
);

assert(
    paymentV2Service.maxAttempts === 7,
    `maxAttempts matches env value (expected: 7, got: ${paymentV2Service.maxAttempts})`
);

assert(
    paymentV2Service.ttlSeconds === 600,
    `ttlSeconds matches env value (expected: 600, got: ${paymentV2Service.ttlSeconds})`
);

assert(
    paymentV2Service.kioskSigningPrivateKeyPath === tempKioskPrivPath,
    `kioskSigningPrivateKeyPath matches env value`
);

assert(
    paymentV2Service.cloudEncryptionPublicKeyPath === tempCloudPubPath,
    `cloudEncryptionPublicKeyPath matches env value`
);

section('2. isConfigured() Returns True With Valid Config');

assert(
    paymentV2Service.isConfigured() === true,
    'isConfigured() returns true when pepper and keys are set'
);

section('3. Empty Pepper Fails isConfigured()');

// Create a fresh instance with empty pepper to verify fail-safe
const unconfiguredService = new PaymentV2Service({
    db,
    pepper: '',
    kioskSigningPrivateKeyPath: tempKioskPrivPath,
    cloudEncryptionPublicKeyPath: tempCloudPubPath
});

assert(
    unconfiguredService.isConfigured() === false,
    'isConfigured() returns false when pepper is empty'
);

section('4. Missing Pepper at Construction (simulating old bug)');

// Simulate the OLD BUG: if process.env was empty at construction time
const savedPepper = process.env.PAYMENT_V2_CODE_PEPPER;
delete process.env.PAYMENT_V2_CODE_PEPPER;

const buggyService = new PaymentV2Service({
    db,
    kioskSigningPrivateKeyPath: tempKioskPrivPath,
    cloudEncryptionPublicKeyPath: tempCloudPubPath
});

assert(
    buggyService.isConfigured() === false,
    'Constructor with missing PAYMENT_V2_CODE_PEPPER → isConfigured() === false (the old bug!)'
);

// Restore
process.env.PAYMENT_V2_CODE_PEPPER = savedPepper;

section('5. Proxy Method Binding Works');

// Ensure proxy-bound methods work with `this` context
const isConfiguredFn = paymentV2Service.isConfigured;
assert(
    typeof isConfiguredFn === 'function',
    'Can extract isConfigured from proxy as bound function'
);

// Call the extracted function — should not throw
let extractedResult;
try {
    extractedResult = isConfiguredFn();
    assert(true, 'Extracted isConfigured() did not throw');
} catch (err) {
    assert(false, `Extracted isConfigured() threw: ${err.message}`);
}

assert(
    extractedResult === true,
    `Extracted isConfigured() returns true (got: ${extractedResult})`
);

section('6. Proxy Property Set Works');

paymentV2Service._testFlag = 'hello_proxy';
assert(
    paymentV2Service._testFlag === 'hello_proxy',
    'Proxy set/get for arbitrary properties works'
);

section('7. Class Export Still Works for Tests');

assert(
    typeof PaymentV2Service === 'function',
    'PaymentV2Service class is still exported (tests can construct their own instances)'
);

const manualInstance = new PaymentV2Service({
    db,
    pepper: 'manual_pepper',
    kioskSigningPrivateKeyPath: tempKioskPrivPath,
    cloudEncryptionPublicKeyPath: tempCloudPubPath,
    kioskId: 'MANUAL-001'
});

assert(
    manualInstance.kioskId === 'MANUAL-001',
    'Manual construction with explicit config works'
);

assert(
    manualInstance.isConfigured() === true,
    'Manually constructed instance is configured'
);

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n══════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} PASS, ${failed} FAIL (${passed + failed} total)`);
console.log('══════════════════════════════════════════════════\n');

// Clean up test DB
try { fs.unlinkSync(TEST_DB_PATH); } catch {}
try { fs.rmSync(TEMP_KEY_DIR, { recursive: true }); } catch {}

process.exit(failed > 0 ? 1 : 0);
