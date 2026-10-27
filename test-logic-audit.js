import test from 'node:test';import assert from 'node:assert/strict';import Database from 'better-sqlite3';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {canonicalMedicineCart} from './src/services/cartValidation.js';
import {stockInteger,assertStockFloor,assertKitCanBeReassigned} from './src/services/inventoryGuards.js';
import {InventoryManager} from './src/services/inventoryManager.js';import {PricingService} from './src/services/pricingService.js';
import {PaymentFinalizationService} from './src/services/paymentFinalizationService.js';
import {saveFeedback,listFeedback} from './src/services/feedbackStore.js';
import {initializeDatabase,closeDatabase} from './src/database/db.js';import {assertSingleFulfillment} from './src/services/fulfillmentMigration.js';
const schema=readFileSync(new URL('./src/database/schema.sql',import.meta.url),'utf8');
function fixture(){const db=new Database(':memory:');db.exec(schema);db.exec(`INSERT INTO sessions(session_id,expires_at) VALUES('S','2099-01-01');
 INSERT INTO transactions(transaction_id,session_id,type,amount,status,cart) VALUES('T','S','MEDICINE',32,'VERIFIED','[{"kit_id":"K","quantity":1}]');
 INSERT INTO inventory(kit_id,name,quantity,price,motor_id) VALUES('K','Test',2,32,1);`);return db;}
test('cart aggregates duplicate IDs and rejects invalid quantities before charging',()=>{
 assert.deepEqual(canonicalMedicineCart([{kit_id:'K',quantity:1},{id:'K',cartQuantity:2}]),[{kit_id:'K',quantity:3}]);
 for(const quantity of [0,-1,1.5,'2junk',true,NaN,11,undefined])assert.throws(()=>canonicalMedicineCart([{kit_id:'K',quantity}]),/Choose/);
 assert.throws(()=>canonicalMedicineCart([{kit_id:'K',quantity:6},{kit_id:'K',quantity:5}]),/Choose/);
 assert.throws(()=>canonicalMedicineCart([{kit_id:'A',quantity:10},{kit_id:'B',quantity:1}]),/per order/);
 assert.throws(()=>canonicalMedicineCart([null]),/Missing/);
});
test('stock changes preserve reservations; quote excludes held stock; pricing policy is unchanged',()=>{
 const db=fixture();try{
  db.exec("INSERT INTO inventory_reservations(reservation_id,transaction_id,kit_id,quantity,status) VALUES('R','T','K',1,'RESERVED')");
  const inventory=new InventoryManager(db),pricing=new PricingService({db,settingsManager:{getTaxRate:()=>12,getPlatformFee:()=>2}});
  for(const value of [1.5,'',true,-1])assert.throws(()=>stockInteger(value));
  assert.throws(()=>inventory.adjustStock('K',-2),/reserved/);assert.equal(inventory.getInventoryItem('K').quantity,2);
  assert.throws(()=>pricing.calculateAuthoritativeCartTotal([{kit_id:'K',quantity:2}]),/Insufficient/);
  assert.equal(pricing.calculateAuthoritativeCartTotal([{kit_id:'K',quantity:1}]).totalPaise,3784);
  assert.throws(()=>assertKitCanBeReassigned(db,'K'),/order/);assert.throws(()=>assertStockFloor({reserved_quantity:1},0),/reserved/);
  db.exec("UPDATE inventory_reservations SET status='COMMITTED'; INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,quantity,state) VALUES('J','S','T','K',1,'COMPLETED')");
  assert.doesNotThrow(()=>assertKitCanBeReassigned(db,'K'));
 }finally{db.close();}
});
test('finalizer rejects a transaction from another session before any mutation',async()=>{
 const service=new PaymentFinalizationService({sessionManager:{getSession:()=>({session_id:'B'})},transactionManager:{getTransaction:()=>({session_id:'A',status:'VERIFIED'})}});
 await assert.rejects(service.finalizeVerifiedPayment({sessionId:'B',transactionId:'T'}),/different kiosk session/);
});
test('offline feedback survives restart and retries do not create duplicate entries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reliv-feedback-'));let db=new Database(join(dir,'db'));
 try{const input={feedbackId:'FB-abcdefgh',name:'Rahul',mood:4,comment:'Please improve instructions'};
  assert.equal(saveFeedback(db,input).created,true);assert.equal(saveFeedback(db,input).created,false);
  assert.throws(()=>saveFeedback(db,{...input,positives:'wrong'}),/choices/);assert.throws(()=>saveFeedback(db,{...input,mood:99}),/rating/);
  db.close();db=new Database(join(dir,'db'));assert.equal(listFeedback(db).length,1);assert.equal(listFeedback(db)[0].payload.name,'Rahul');
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('legacy duplicates keep completed evidence and quarantine pending jobs across restarts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reliv-duplicates-')),path=join(dir,'db'),db=new Database(path);
 db.exec(schema.replace('CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_jobs_txn_kit ON fulfillment_jobs(transaction_id, kit_id);',''));
 db.exec(`INSERT INTO sessions(session_id,expires_at) VALUES('S','2099-01-01'); INSERT INTO transactions(transaction_id,session_id,type,amount,status) VALUES('T','S','MEDICINE',32,'VERIFIED'); INSERT INTO inventory(kit_id,name,quantity,price,motor_id) VALUES('K','Test',2,32,1);
 INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,quantity,state,esp32_ack_payload) VALUES('J1','S','T','K',1,'COMPLETED','evidence'),('J2','S','T','K',1,'PENDING',NULL);`);db.close();
 try{for(let restart=0;restart<2;restart++){
  const live=initializeDatabase(path);assert.equal(live.prepare('SELECT COUNT(*) n FROM fulfillment_jobs').get().n,2);
  assert.equal(live.prepare("SELECT esp32_ack_payload FROM fulfillment_jobs WHERE job_id='J1'").get().esp32_ack_payload,'evidence');
  assert.equal(live.prepare("SELECT state FROM fulfillment_jobs WHERE job_id='J2'").get().state,'MANUAL_REVIEW_REQUIRED');
  assert.throws(()=>assertSingleFulfillment(live,'T','K'),/staff review/);closeDatabase();
 }}finally{closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
