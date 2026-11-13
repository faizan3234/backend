import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {createCustomerSupportRouter} from './payment-bridge-service/customerSupportRoutes.js';
import {createGrowthRouter} from './src/routes/growthRoutes.js';

test('real support storage handles retries and DB failure without a fake success; obsolete routes fail closed', async () => {
 const db = new Database(':memory:');
 db.exec('CREATE TABLE support_cases (case_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE)');
 const app=express();app.use(express.json());app.use(createGrowthRouter({local:true}));
 app.use(createCustomerSupportRouter({getDb:()=>db,local:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
 try {
  const body={requestId:'a'.repeat(32),page:'Weight',issue:'Scale does not respond'};
  const first=await post('/api/support-issue',body);assert.equal(first.status,200);assert.equal(first.data.saved,true);assert.equal(first.data.notified,false);
  assert.equal((await post('/api/support-issue',body)).data.caseId,first.data.caseId);
  assert.equal((await post('/api/support-issue',{...body,issue:'Changed'})).status,409);
  assert.equal((await post('/api/support-issue',{page:'Weight'})).status,400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ui_support_issues').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM support_cases').get().n,0);
  for(const path of ['/api/weight/tare','/api/weight/reset']){const r=await post(path,{});assert.equal(r.status,501);assert.equal(r.data.ok,false);}
  const email=await post('/api/send-health-card',{to:'victim@example.com',cardImage:'<img onerror=evil>'});assert.equal(email.status,410);assert.equal(email.data.sent,false);assert.equal(email.data.queued,false);
  assert.equal((await post('/api/growth/referral/claim',{})).status,503);
  db.close();const failed=await post('/api/support-issue',{...body,requestId:'b'.repeat(32)});assert.equal(failed.status,503);assert.equal(failed.data.saved,false);
 } finally {await new Promise(r=>server.close(r));if(db.open)db.close();}
});
