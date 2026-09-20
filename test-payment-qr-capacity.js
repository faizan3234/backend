import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { encryptPackage, decryptPackage as decryptOnPi, signPayload, base64UrlEncode } from './src/services/paymentV2Crypto.js';
import { decryptPackage, verifyKioskSignature } from './payment-bridge-service/paymentV2Crypto.js';

const dir = mkdtempSync(join(tmpdir(), 'reliv-qr-capacity-'));
process.env.DB_PATH = join(dir, 'test.db');
const { initializeDatabase, closeDatabase } = await import('./src/database/db.js');
const { default: sessions } = await import('./src/services/sessionManager.js');
const { transactionManager } = await import('./src/services/transactionManager.js');
const { PaymentV2Service } = await import('./src/services/paymentV2Service.js');
const db = initializeDatabase(process.env.DB_PATH);
sessions.initialize();
transactionManager.initialize();
after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

// Match the production key generator, not the old tests' smaller 2048-bit keys.
const kiosk = crypto.generateKeyPairSync('ed25519');
const cloud = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
const service = new PaymentV2Service({ db, pepper: 'synthetic-test-pepper', kioskId: 'RELIV-001' });
service._kioskPrivateKey = kiosk.privateKey;
service._cloudPublicKey = cloud.publicKey;
const fixtures = {};
for (let slot = 1; slot <= 3; slot++) {
  db.prepare('INSERT OR REPLACE INTO inventory (kit_id, name, price, quantity, motor_id) VALUES (?, ?, ?, ?, ?)')
    .run(`KIT-QR-${slot}`, ['First Aid Kit', 'Travel Health Kit', 'Women Care Kit'][slot - 1], 50 + slot, 100, slot);
}

test('real medicine requests with production keys fit QR and keep payment identity on retry', async () => {
  for (const count of [1, 2, 3]) {
    const session = sessions.createSession('RELIV-001', 'MEDICINE');
    const cart = Array.from({ length: count }, (_, i) => ({ kit_id: `KIT-QR-${i + 1}`, quantity: i + 1 }));
    const request = await service.createPaymentRequest(session.session_id, { serviceType: 'MEDICINE', cart });
    const decoded = decryptPackage(request.paymentUrl.split('#p=')[1], cloud.privateKey);
    assert.ok(verifyKioskSignature(decoded.payload, decoded.signature, kiosk.publicKey));
    assert.equal(decoded.payload.items.length, count);
    assert.equal(decoded.payload.amount, request.amount);
    assert.equal(decoded.payload.sessionId, session.session_id);
    assert.deepEqual(decoded.payload.items.map(item => item.quantity), cart.map(item => item.quantity));
    assert.ok(Buffer.byteLength(request.paymentUrl) <= 2200);
    assert.doesNotThrow(() => QRCode.create(request.paymentUrl, { errorCorrectionLevel: 'M' }));
    const repeated = await service.createPaymentRequest(session.session_id, { serviceType: 'MEDICINE', cart });
    assert.equal(repeated.requestId, request.requestId);
    assert.equal(repeated.paymentUrl, request.paymentUrl);

    const legacyUrl = 'https://reliv7.vercel.app/pay#p=' + encryptPackage({ payload: decoded.payload, signature: decoded.signature }, cloud.publicKey);
    const legacy = decryptPackage(legacyUrl.split('#p=')[1], cloud.privateKey);
    assert.deepEqual(legacy.payload, decoded.payload);
    assert.ok(legacyUrl.length > 2200, 'reproduces the merged frontend limit rejecting real backend requests');
    fixtures[`medicine${count}`] = { legacyUrl, paymentUrl: request.paymentUrl, amount: request.amount };
    console.log(`QR capacity: ${count} item(s), legacy ${legacyUrl.length}, compressed ${request.paymentUrl.length} bytes`);
  }
  if (process.env.RELIV_QR_FIXTURES_PATH) writeFileSync(process.env.RELIV_QR_FIXTURES_PATH, JSON.stringify(fixtures, null, 2) + '\n');
});

test('health report snapshot, Unicode customer data and signature survive compression', async () => {
  const session = sessions.createSession('RELIV-001', 'HEALTH_CHECKUP');
  const health = { patient: { name: 'Synthetic বাংলা हिंदी', age: 28, gender: 'female' }, vitals: {
    systolic: 120, diastolic: 80, oxygen: 98, bpm: 75, temperature: 36.7,
    leftEye: '6/6', rightEye: '6/6', weight: 64, height: 171, impedance: 510,
    bodyFat: 23, muscleMass: 45, boneMass: 3, bodyWater: 55, skeletalMuscle: 32,
    ffmi: 18, bmr: 1600, metabolicAge: 29, isAthlete: false,
  } };
  db.prepare("UPDATE sessions SET status = 'MEASUREMENTS_COMPLETE', health_data = ? WHERE session_id = ?")
    .run(JSON.stringify(health), session.session_id);
  const request = await service.createPaymentRequest(session.session_id, { serviceType: 'HEALTH_CHECKUP' });
  const decoded = decryptPackage(request.paymentUrl.split('#p=')[1], cloud.privateKey);
  assert.deepEqual(decoded.payload.healthReportSnapshot, { version: 1, ...health });
  assert.ok(verifyKioskSignature(decoded.payload, decoded.signature, kiosk.publicKey));
  assert.ok(request.paymentUrl.length <= 2953);
  assert.doesNotThrow(() => QRCode.create(request.paymentUrl, { errorCorrectionLevel: request.paymentUrl.length <= 2331 ? 'M' : 'L' }));
  console.log(`QR capacity: full health snapshot ${request.paymentUrl.length} bytes`);
});

test('legacy and compressed envelopes round-trip through both decoders', () => {
  const payload = { kioskId: 'RELIV-001', confirmationCode: '0042', note: 'synthetic '.repeat(80) };
  const inner = { payload, signature: signPayload(payload, kiosk.privateKey) };
  for (const compress of [false, true]) {
    const encoded = encryptPackage(inner, cloud.publicKey, { compress });
    assert.deepEqual(decryptOnPi(encoded, cloud.privateKey), inner);
    const result = decryptPackage(encoded, cloud.privateKey);
    assert.deepEqual(result.payload, payload);
    assert.ok(verifyKioskSignature(result.payload, result.signature, kiosk.publicKey));
  }
});

test('unencodable details never persist an active QR and can recover after correction', async () => {
  const session = sessions.createSession('RELIV-001', 'MEDICINE');
  const cart = [{ kit_id: 'KIT-QR-1', quantity: 1 }];
  db.prepare('UPDATE sessions SET customer_data = ? WHERE session_id = ?')
    .run(JSON.stringify({ name: crypto.randomBytes(4096).toString('base64') }), session.session_id);
  await assert.rejects(service.createPaymentRequest(session.session_id, { serviceType: 'MEDICINE', cart }), { code: 'PAYMENT_QR_TOO_LARGE' });
  assert.equal(service.getPaymentStatus(session.session_id).status, 'NONE');
  db.prepare('UPDATE sessions SET customer_data = ? WHERE session_id = ?')
    .run(JSON.stringify({ name: 'Synthetic Customer' }), session.session_id);
  const request = await service.createPaymentRequest(session.session_id, { serviceType: 'MEDICINE', cart });
  assert.ok(request.paymentUrl.length <= 2953);
  assert.equal(service.getPaymentStatus(session.session_id).requestId, request.requestId);
});

test('compression marker and encrypted bytes cannot be tampered with', () => {
  const encoded = encryptPackage({ payload: { note: 'synthetic '.repeat(80) }, signature: 'synthetic' }, cloud.publicKey, { compress: true });
  const envelope = JSON.parse(Buffer.from(encoded, 'base64url'));
  const changedCiphertext = Buffer.from(envelope.ct, 'base64url');
  changedCiphertext[0] ^= 1;
  for (const altered of [{ ...envelope, zip: undefined }, { ...envelope, zip: 'UNKNOWN' }, { ...envelope, ct: changedCiphertext.toString('base64url') }]) {
    const tampered = base64UrlEncode(JSON.stringify(altered));
    assert.throws(() => decryptPackage(tampered, cloud.privateKey));
    assert.throws(() => decryptOnPi(tampered, cloud.privateKey));
  }
});

test('decompression is bounded even for a valid encrypted expansion bomb', () => {
  const aesKey = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(Buffer.from('RELIV_PAYMENT_V2:DEF'));
  const ct = Buffer.concat([cipher.update(deflateRawSync(Buffer.alloc(128 * 1024, 65))), cipher.final()]);
  const ek = crypto.publicEncrypt({ key: cloud.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey);
  const bomb = base64UrlEncode(JSON.stringify({ v: 2, ek: base64UrlEncode(ek), iv: base64UrlEncode(iv), ct: base64UrlEncode(ct), tag: base64UrlEncode(cipher.getAuthTag()), zip: 'DEF' }));
  assert.throws(() => decryptPackage(bomb, cloud.privateKey), /larger than|too large/i);
  assert.throws(() => decryptOnPi(bomb, cloud.privateKey), /larger than|too large/i);
});
