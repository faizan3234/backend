import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {randomBytes} from 'node:crypto';
import {createGrowthRouter} from './growthRoutes.js';
import {createLegacyCustomerRouter} from './legacyCustomerRoutes.js';
import {GrowthService} from './services/growthService.js';

test('old ledger is preserved and restart does not reimport untrusted credits', () => {
 const db = new Database(':memory:');
 try {
  db.exec("CREATE TABLE growth_referrals (referral_id TEXT PRIMARY KEY, referrer_user_id TEXT); INSERT INTO growth_referrals VALUES ('old-referral','old-user')");
  const service = new GrowthService({db});
  assert.equal(service.adminOverview().overview.legacyRecordsAwaitingReview,1);
  assert.equal(service.leaderboard().leaderboard.length,0);
  new GrowthService({db});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM growth_referrals_legacy_v1').get().n,1);
 } finally { db.close(); }
});

test('separate browser accounts receive the same named leaderboard and legacy routes cannot bypass verification', async () => {
 const db = new Database(':memory:');
 const app = express(); app.use(express.json());
 app.use('/api/growth',createGrowthRouter({db})); app.use(createLegacyCustomerRouter());
 const server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 const base = `http://127.0.0.1:${server.address().port}`;
 const post = async (path,body,token) => { const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}; };
 try {
  const register = async()=> (await post('/api/growth/referrals?action=register',{registrationKey:randomBytes(32).toString('hex')})).data;
  const faizan=await register(),raj=await register();
  await post('/api/growth/referrals?action=profile',{name:'Faizan'},faizan.token);
  await post('/api/growth/referrals?action=profile',{name:'Raj'},raj.token);
  const claim=await post('/api/growth/referrals?action=claim',{refCode:faizan.identity.referralCode},raj.token); assert.equal(claim.status,200);
  const board=async token=>(await fetch(base+'/api/growth/referrals?action=leaderboard',{headers:{Authorization:`Bearer ${token}`}})).json();
  const first=await board(faizan.token),second=await board(raj.token);assert.deepEqual(first.leaderboard,second.leaderboard);
  assert.equal(first.leaderboard.length,1);assert.equal(first.leaderboard[0].displayName,'Faizan');assert.equal(first.leaderboard[0].score,1);
  await post('/api/growth/referrals?action=claim',{refCode:faizan.identity.referralCode},raj.token);
  assert.equal((await board(raj.token)).leaderboard[0].score,1);
  for (const path of ['/api/growth/referral/create','/growth/referral/claim','/api/admin/leaderboard/reset']) {
   const r=await post(path,{userId:'fake',passkey:'reliv-admin-2026'});assert.equal(r.status,410);assert.equal(r.data.ok,false);
  }
  for (const path of ['/api/streak/restore/order','/api/streak/restore/verify','/api/goal/claim','/api/store/order']) {
   const r=await post(path,{razorpay_payment_id:'pay_fake',streakDays:100});assert.equal(r.status,503);assert.equal(r.data.ok,false);assert.equal(r.data.verified,undefined);
  }
 } finally {await new Promise(r=>server.close(r));db.close();}
});
