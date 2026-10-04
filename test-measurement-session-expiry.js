import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase, closeDatabase } from './src/database/db.js';
import manager from './src/services/sessionManager.js';
const db=initializeDatabase(':memory:');manager.initialize();
const data={patient:{name:'Test',age:32,gender:'male'},vitals:{height:178,weight:68,systolic:123,diastolic:78,bpm:98,oxygen:98,temperature:99}};
function fixture(ageMinutes=10.02) {
 const s=manager.createSession();manager.setPairingToken(s.session_id,'token-'+s.session_id);
 manager.attachCustomer(s.session_id,data.patient);manager.selectService(s.session_id,'HEALTH_CHECKUP');
 db.prepare('UPDATE sessions SET created_at=?, expires_at=? WHERE session_id=?').run(new Date(Date.now()-ageMinutes*60000).toISOString(),new Date(Date.now()-1000).toISOString(),s.session_id);
 return {id:s.session_id,token:'token-'+s.session_id};
}
test('the exact 10-minute-plus-one-second failure preserves readings and identity',()=>{
 const {id,token}=fixture();manager.expireOldSessions();
 const s=manager.completeHealthMeasurements(id,token,data);
 assert.equal(s.session_id,id);assert.equal(s.status,'MEASUREMENTS_COMPLETE');assert.deepEqual(s.health_data,data);
 assert.ok(Date.parse(s.expires_at)>Date.now()+9*60000);assert.equal(s.payment_status,'NOT_REQUIRED');assert.equal(s.pairing_used,0);
 assert.equal(db.prepare('SELECT count(*) n FROM transactions WHERE session_id=?').get(id).n,0);
 assert.deepEqual(manager.completeHealthMeasurements(id,token,data).health_data,data);
 assert.throws(()=>manager.completeHealthMeasurements(id,token,{...data,vitals:{...data.vitals,temperature:100}}),e=>e.code==='HEALTH_SNAPSHOT_MISMATCH');
});
test('new health service gets 30 minutes without removing entry expiry',()=>{
 const s=manager.createSession();assert.ok(Date.parse(s.expires_at)<Date.now()+11*60000);
 manager.selectService(s.session_id,'HEALTH_CHECKUP');assert.ok(Date.parse(manager.getSession(s.session_id).expires_at)>Date.now()+29*60000);
});
test('bad/consumed pairing tokens and payment states cannot renew',()=>{
 const {id,token}=fixture();const old=manager.getSession(id).expires_at;
 assert.throws(()=>manager.completeHealthMeasurements(id,'wrong',data));assert.equal(manager.getSession(id).expires_at,old);
 for(const status of ['PAYMENT_PENDING','PAYMENT_VERIFIED','COMPLETED']){
  db.prepare('UPDATE sessions SET status=? WHERE session_id=?').run(status,id);
  assert.throws(()=>manager.completeHealthMeasurements(id,token,data));
 }
 db.prepare("UPDATE sessions SET status='SERVICE_SELECTED',pairing_used=1 WHERE session_id=?").run(id);
 assert.throws(()=>manager.completeHealthMeasurements(id,token,data));
});
test('payment transaction blocks recovery even if session state is inconsistent',()=>{
 const {id,token}=fixture();
 db.prepare("INSERT INTO transactions(transaction_id,session_id,type,amount) VALUES(?,?,'HEALTH_CHECKUP',17)").run('T-'+id,id);
 assert.throws(()=>manager.completeHealthMeasurements(id,token,data),e=>e.code==='MEASUREMENTS_CONFLICT');
});
test('invalid snapshot rolls back the expiry extension',()=>{
 const {id,token}=fixture();const old=manager.getSession(id).expires_at;
 assert.throws(()=>manager.completeHealthMeasurements(id,token,{}));assert.equal(manager.getSession(id).expires_at,old);
});
test('45-minute hard limit rejects recovery and cleanup handles ISO dates',()=>{
 const {id,token}=fixture(46);
 assert.throws(()=>manager.completeHealthMeasurements(id,token,data),e=>e.code==='SESSION_EXPIRED');
 manager.expireOldSessions();assert.equal(manager.getSession(id).status,'COMPLETED');
});
test.after(()=>closeDatabase());
