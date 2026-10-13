import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import {readFileSync} from 'node:fs';
import {initializeSupport,createSupportCase,supportEvidence,registerSupportRoutes} from './src/services/supportCases.js';
function fixture(){
 const db=new Database(':memory:');db.exec(readFileSync(new URL('./src/database/schema.sql',import.meta.url),'utf8'));initializeSupport(db);
 db.prepare("INSERT INTO sessions(session_id,service_type,pairing_token,expires_at) VALUES('S','MEDICINE',?,'2000-01-01')").run('a'.repeat(64));
 db.prepare("INSERT INTO transactions(transaction_id,session_id,type,amount,status,provider_payment_id) VALUES('T','S','MEDICINE',32,'VERIFIED','pay_123')").run();
 db.prepare("INSERT INTO inventory(kit_id,name,price,quantity,motor_id) VALUES('K','Paracetamol',32,2,1)").run();
 db.prepare("INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,quantity,motor_id,state,esp32_ack_payload) VALUES('J','S','T','K',1,1,'COMPLETED','{\"status\":\"SUCCESS\"}')").run();
 return db;
}
test('expired paid session may complain; wrong or missing tokens fail; repeat presses preserve original evidence',()=>{
 const db=fixture();try{
  for(const token of [null,'', 'b'.repeat(64),{},'a'])assert.throws(()=>createSupportCase(db,'S',token),{status:403});
  const first=createSupportCase(db,'S','a'.repeat(64));
  db.prepare("UPDATE inventory SET quantity=1 WHERE kit_id='K'").run();
  assert.equal(createSupportCase(db,'S','a'.repeat(64)).case_id,first.case_id);
  const original=JSON.parse(db.prepare('SELECT evidence_json FROM support_cases').get().evidence_json);
  assert.equal(original.jobs[0].recorded_stock_now,2);assert.equal(supportEvidence(db,'S').jobs[0].recorded_stock_now,1);
  assert.match(original.limitations,/not proof/);assert.equal(original.payments[0].status,'VERIFIED');
  assert.equal(JSON.stringify(original).includes('pairing_token'),false);assert.equal(JSON.stringify(original).includes('customer_data'),false);
  assert.equal(db.prepare('SELECT state FROM fulfillment_jobs').get().state,'COMPLETED');
 }finally{db.close();}
});
test('protected admin lookup, receipt correlation, bounded input and append-only notes; no stock/payment changes',async()=>{
 const db=fixture(),app=express();app.use(express.json());registerSupportRoutes(app,{getDb:()=>db,requireAdmin:(req,res,next)=>{if(req.get('Authorization')!=='test-admin')return res.sendStatus(401);req.admin={email:'staff@example.test'};next();}});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
 const headers={'Authorization':'test-admin','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(base+'/api/admin/support')).status,401);
  assert.equal((await fetch(base+'/api/admin/support',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"sessionId":"S"}'})).status,401);
  let r=await fetch(base+'/api/admin/support?reference=pay_123',{headers});let data=await r.json();assert.equal(data.evidence.session.session_id,'S');assert.equal(data.complaint,null);
  r=await fetch(base+'/api/admin/support',{method:'POST',headers,body:'{"sessionId":"S"}'});const id=(await r.json()).case.case_id;
  for(let i=0;i<2;i++)assert.equal((await fetch(base+`/api/admin/support/${id}/notes`,{method:'POST',headers,body:JSON.stringify({status:'INVESTIGATING',note:'Checking receipt and collection tray.'})})).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM support_notes').get().n,1);
  assert.equal((await fetch(base+`/api/admin/support/${id}/notes`,{method:'POST',headers,body:'{"status":"REFUNDED","note":"Attempt auto refund"}'})).status,400);
  assert.equal((await fetch(base+'/api/admin/support?reference='+encodeURIComponent("' OR 1=1 --"),{headers})).status,404);
  r=await fetch(base+'/api/admin/support?reference='+id,{headers});data=await r.json();assert.equal(data.notes[0].actor,'staff@example.test');assert.equal(data.complaint.status,'INVESTIGATING');assert.match(r.headers.get('cache-control'),/no-store/);
  assert.equal(db.prepare('SELECT quantity FROM inventory').get().quantity,2);assert.equal(db.prepare('SELECT status FROM transactions').get().status,'VERIFIED');
 }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
