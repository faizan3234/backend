import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { InventoryManager } from './src/services/inventoryManager.js';
import { finalizeDispenseAck } from './src/services/finalizeDispenseAck.js';
test('completion and inventory roll back together; replay cannot deduct twice', () => {
 const db = new Database(':memory:'); db.exec(readFileSync(new URL('./src/database/schema.sql', import.meta.url), 'utf8'));
 db.exec(`INSERT INTO sessions(session_id,expires_at) VALUES('S','2099-01-01'); INSERT INTO transactions(transaction_id,session_id,type,amount,status) VALUES('T','S','MEDICINE',32,'VERIFIED'); INSERT INTO inventory(kit_id,name,quantity,price,motor_id) VALUES('K','Test item',2,32,1); INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,quantity,state) VALUES('J','S','T','K',1,'IN_PROGRESS'); INSERT INTO inventory_reservations(reservation_id,transaction_id,kit_id,quantity,status) VALUES('R','T','K',1,'RESERVED');`);
 const inventory = new InventoryManager(db), fulfillment = { markCompleted: () => { db.exec("UPDATE fulfillment_jobs SET state='COMPLETED' WHERE job_id='J'"); return true; }, getJobStatus: () => db.prepare("SELECT * FROM fulfillment_jobs WHERE job_id='J'").get() };
 db.exec("CREATE TRIGGER fail_stock BEFORE UPDATE ON inventory BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
 assert.throws(() => finalizeDispenseAck(db, fulfillment, inventory, 'J', {}), /simulated disk failure/);
 assert.equal(fulfillment.getJobStatus().state, 'IN_PROGRESS'); assert.equal(db.prepare('SELECT status FROM inventory_reservations').get().status, 'RESERVED');
 db.exec('DROP TRIGGER fail_stock'); assert.equal(finalizeDispenseAck(db, fulfillment, inventory, 'J', {}), true); assert.equal(finalizeDispenseAck(db, fulfillment, inventory, 'J', {}), true);
 assert.equal(db.prepare('SELECT quantity FROM inventory').get().quantity, 1);
 db.exec("DELETE FROM inventory_reservations; UPDATE fulfillment_jobs SET state='IN_PROGRESS'");
 assert.throws(() => finalizeDispenseAck(db, fulfillment, inventory, 'J', {}), /reservation mismatch/); assert.equal(fulfillment.getJobStatus().state, 'IN_PROGRESS'); db.close();
});
