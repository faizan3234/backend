import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import manager from '../src/services/fulfillmentManager.js';
import InventoryManager from '../src/services/inventoryManager.js';
import { finalizeDispenseAck } from '../src/services/finalizeDispenseAck.js';
import { dispenseReceipt } from '../src/services/dispenseReceipt.js';

function setup(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('../src/database/schema.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO sessions(session_id,expires_at) VALUES('S','2099-01-01');
    INSERT INTO transactions(transaction_id,session_id,type,amount,status,cart)
      VALUES('T','S','MEDICINE',32,'VERIFIED','[{"kit_id":"K","quantity":1}]');
    INSERT INTO inventory(kit_id,name,quantity,price,motor_id) VALUES('K','Test',4,32,1);
    INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,motor_id,quantity,state)
      VALUES('J','S','T','K',1,1,'PENDING');`);
  const fulfillment = Object.create(manager);
  Object.defineProperty(fulfillment, 'db', {value:db});
  const messages=[];
  fulfillment.setMqttClient({connected:true,publish:(topic,payload,options,callback)=>{
    messages.push({topic,payload:JSON.parse(payload)}); callback();
  }});
  const inventory=new InventoryManager(db);
  const ack={jobId:'J',kitId:'K',motor:1,quantity:1,status:'SUCCESS',success:true,
    receiptProtocol:2,confirmationType:'timed_motor_cycle',deliveryVerified:false};
  return {db,fulfillment,messages,inventory,ack};
}

test('V2 missing reservation: dispatch -> ACK -> durable receipt, replay deducts once', async t=>{
  const {db,fulfillment,messages,inventory,ack}=setup(t);
  await fulfillment.startDispensing('J');
  assert.equal(db.prepare('SELECT status FROM inventory_reservations').get().status,'RESERVED');
  assert.equal(messages.length,1);
  assert.equal(finalizeDispenseAck(db,fulfillment,inventory,'J',ack),true);
  assert.equal(fulfillment.getJobStatus('J').state,'COMPLETED');
  assert.equal(dispenseReceipt(fulfillment.getJobStatus('J'),ack).recorded,true);
  assert.equal(finalizeDispenseAck(db,fulfillment,inventory,'J',ack),true);
  assert.equal(await fulfillment.startDispensing('J'),false);
  assert.equal(messages.length,1);
  assert.equal(db.prepare('SELECT quantity FROM inventory').get().quantity,3);
});
test('legacy reservation reused without duplication',async t=>{
  const {db,fulfillment,inventory}=setup(t);
  inventory.reserveInventory('T','MEDICINE');
  await fulfillment.startDispensing('J');
  assert.equal(db.prepare('SELECT count(*) n FROM inventory_reservations').get().n,1);
});
for (const [name,sql] of [
  ['out of stock','UPDATE inventory SET quantity=0'],
  ['unpaid',"UPDATE transactions SET status='PENDING'"],
  ['wrong paid quantity',"UPDATE transactions SET cart='[{\"kit_id\":\"K\",\"quantity\":2}]'"],
  ['previously published',"UPDATE fulfillment_jobs SET mqtt_published_at=datetime('now')"],
  ['wrong reservation',"INSERT INTO inventory_reservations(reservation_id,transaction_id,kit_id,quantity,status) VALUES('R','T','K',2,'RESERVED')"],
  ['already deducted',"INSERT INTO inventory_reservations(reservation_id,transaction_id,kit_id,quantity,status) VALUES('R','T','K',1,'COMMITTED')"]
]) test(`${name}: review BEFORE motor command`,async t=>{
  const {db,fulfillment,messages}=setup(t); db.exec(sql);
  await assert.rejects(fulfillment.startDispensing('J'));
  assert.equal(messages.length,0);
  assert.equal(fulfillment.getJobStatus('J').state,'MANUAL_REVIEW_REQUIRED');
});
test('claim write failure rolls back newly reserved stock',async t=>{
  const {db,fulfillment,messages}=setup(t);
  db.exec(`CREATE TRIGGER fail_claim BEFORE UPDATE ON fulfillment_jobs WHEN NEW.state='IN_PROGRESS'
    BEGIN SELECT RAISE(ABORT,'claim failed'); END;`);
  await assert.rejects(fulfillment.startDispensing('J'),/claim failed/);
  assert.equal(messages.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM inventory_reservations').get().n,0);
});
test('restart/uncertain orders never gain a fresh reservation or motor command',async t=>{
  const {db,fulfillment,messages}=setup(t);
  db.exec("UPDATE fulfillment_jobs SET state='MANUAL_REVIEW_REQUIRED'");
  assert.equal(await fulfillment.startDispensing('J'),false);
  assert.equal(messages.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM inventory_reservations').get().n,0);
});
