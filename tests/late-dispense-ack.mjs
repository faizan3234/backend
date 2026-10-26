import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { finalizeDispenseAck } from '../src/services/finalizeDispenseAck.js';
import { dispenseReceipt } from '../src/services/dispenseReceipt.js';
const ack={jobId:'J',kitId:'K',motor:1,quantity:1,status:'SUCCESS',success:true,receiptProtocol:2};
function setup(state='MANUAL_REVIEW_REQUIRED') {
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE fulfillment_jobs(job_id TEXT PRIMARY KEY,kit_id TEXT,motor_id INTEGER,quantity INTEGER,state TEXT,mqtt_published_at TEXT,esp32_ack_received_at TEXT,esp32_ack_payload TEXT);`);
 db.prepare('INSERT INTO fulfillment_jobs VALUES(?,?,?,?,?,?,NULL,NULL)').run('J','K',1,1,state,'2026-10-26 08:00:00');
 const read=()=>db.prepare('SELECT * FROM fulfillment_jobs WHERE job_id=?').get('J');
 const fulfillment={getJobStatus:read, markCompleted:()=>{throw Error('Must not complete late job');}};
 const inventory={deductInventory:()=>{throw Error('Must not deduct stock for late evidence');}};
 return {db,read,finalize:a=>finalizeDispenseAck(db,fulfillment,inventory,'J',a)};
}
test('late success breaks ACK deadlock without completing job or deducting stock',()=>{
 const {db,read,finalize}=setup();
 assert.equal(dispenseReceipt(read(),ack),null);
 assert.equal(finalize(ack),false);
 assert.equal(read().state,'MANUAL_REVIEW_REQUIRED');
 assert.equal(JSON.parse(read().esp32_ack_payload).jobId,'J');
 assert.equal(dispenseReceipt(read(),ack).jobState,'MANUAL_REVIEW_REQUIRED');
 const before=read(); assert.equal(finalize(ack),false); assert.deepEqual(read(),before);
 assert.equal(dispenseReceipt(read(),{...ack,receiptProtocol:undefined}),null);
 db.close();
});
test('wrong identity, non-final state and inconsistent success cannot release outbox',()=>{
 const {db,read,finalize}=setup();
 for(const bad of [{...ack,jobId:'X'},{...ack,kitId:'X'},{...ack,motor:2},{...ack,quantity:2},{...ack,status:'RUNNING'},{...ack,success:false}]) {
  assert.equal(finalize(bad),false); assert.equal(read().esp32_ack_payload,null); assert.equal(dispenseReceipt(read(),bad),null);
 }
 db.close();
});
test('first failure evidence is not overwritten by a later success',()=>{
 const {db,read,finalize}=setup(); const failed={...ack,status:'ERROR',success:false};
 finalize(failed); const before=read(); finalize(ack); assert.deepEqual(read(),before);
 assert.equal(dispenseReceipt(read(),ack),null);
 assert.equal(dispenseReceipt(read(),failed).recorded,true); db.close();
});
test('disk failure cannot produce a receipt or erase manual review',()=>{
 const {db,read,finalize}=setup();
 db.exec("CREATE TRIGGER fail BEFORE UPDATE ON fulfillment_jobs BEGIN SELECT RAISE(ABORT,'disk failed'); END");
 assert.throws(()=>finalize(ack),/disk failed/); assert.equal(read().esp32_ack_payload,null);
 assert.equal(dispenseReceipt(read(),ack),null); db.close();
});
test('never record a result for an unpublished job',()=>{
 const {db,read,finalize}=setup(); db.exec('UPDATE fulfillment_jobs SET mqtt_published_at=NULL');
 finalize(ack); assert.equal(read().esp32_ack_payload,null); db.close();
});
