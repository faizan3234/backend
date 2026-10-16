import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { PaymentV2CloudService } from './paymentV2Service.js';
import { initPaymentV2Schema } from './paymentV2Db.js';
import { encryptPackage, signPayload } from '../src/services/paymentV2Crypto.js';
import { computePayloadFingerprint, encryptConfirmationCodeAtRest } from './paymentV2Crypto.js';
import { storySummary } from './services/storySummary.js';
test('export requires flag, exact signed package and captured health payment; preserves ordinal and score', () => {
 const db = new Database(':memory:'); initPaymentV2Schema(db);
 const kiosk = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type:'pkcs8', format:'pem' }, publicKeyEncoding:{ type:'spki', format:'pem' } });
 const cloud = crypto.generateKeyPairSync('rsa', { modulusLength:2048, privateKeyEncoding:{ type:'pkcs8', format:'pem' }, publicKeyEncoding:{ type:'spki', format:'pem' } });
 const service = Object.create(PaymentV2CloudService.prototype); Object.assign(service, { db, codeSecret:'synthetic-test-secret', getCloudPrivateKey:()=>cloud.privateKey, getKioskPublicKey:()=>kiosk.publicKey });
 const payload = { requestId:'r', kioskId:'K', amount:1700, confirmationCode:'1234' };
 const pack = p => encryptPackage({ payload:p, signature:signPayload(p,kiosk.privateKey) },cloud.publicKey);
 const snapshot = { profileKey:'opaque-person', scanNumber:8, patient:{name:'Asha',age:30,gender:'female'}, vitals:{weight:65,height:170,oxygen:98} };
 db.prepare(`INSERT INTO payment_v2_orders(order_id,request_id,request_nonce,payload_fingerprint,session_id,transaction_id,kiosk_id,amount,service_type,encrypted_code,status,razorpay_payment_id,created_at,expires_at,encrypted_health_snapshot) VALUES('o','r','n',?,'s','t','K',1700,'HEALTH_CHECKUP','x','PAID','pay',1,2,?)`).run(computePayloadFingerprint(payload),encryptConfirmationCodeAtRest(JSON.stringify(snapshot),service.codeSecret));
 const prior=process.env.RELIV_APP_REPORT_SYNC;
 try {
  process.env.RELIV_APP_REPORT_SYNC='false'; assert.throws(()=>service.exportAppRecord(pack(payload)),/disabled/);
  process.env.RELIV_APP_REPORT_SYNC='true'; const result=service.exportAppRecord(pack(payload));
  assert.equal(result.record.scanNumber,8); assert.equal(result.record.profileKey,'K:opaque-person'); assert.deepEqual(result.record.summary,storySummary(snapshot)); assert.ok(!JSON.stringify(result).includes('1234')); assert.ok(!('pdf' in result.record));
  assert.throws(()=>service.exportAppRecord(pack({...payload,amount:1})),/unavailable/);
  db.exec("UPDATE payment_v2_orders SET status='CREATED'"); assert.throws(()=>service.exportAppRecord(pack(payload)),/unavailable/);
  db.exec("UPDATE payment_v2_orders SET status='PAID',service_type='MEDICINE'"); assert.throws(()=>service.exportAppRecord(pack(payload)),/unavailable/);
  assert.throws(()=>service.exportAppRecord('broken'));
 } finally { if(prior===undefined)delete process.env.RELIV_APP_REPORT_SYNC;else process.env.RELIV_APP_REPORT_SYNC=prior;db.close(); }
});
