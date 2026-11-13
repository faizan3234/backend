import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import {GrowthService} from './services/growthService.js';
import {createGoogleVerifier} from './services/growthIdentity.js';
import {createGrowthRouter} from './growthRoutes.js';
import {createGrowthRateLimiter} from './services/growthRateLimit.js';
const key=()=>randomBytes(32).toString('hex');
const fixture=()=>{const db=new Database(':memory:');db.pragma('foreign_keys = ON');let now=Date.parse('2026-11-08T12:00:00Z');return {db,service:new GrowthService({db,clock:()=>now}),advance:()=>{now+=86400000;}};};
const user=(s,account)=>s.authenticate(account.token);

test('rate limits separate trusted proxy clients but ignore forged client headers',()=>{
 let now=1000;const limiter=createGrowthRateLimiter({env:{GROWTH_PROXY_SECRET:'proxy-test-secret'},max:2,clock:()=>now});
 const request=(client,secret)=>{
  let allowed=false;const res={code:200,headers:{},status(n){this.code=n;return this;},json(){return this;},set(k,v){this.headers[k]=v;return this;}};
  limiter({ip:'proxy-egress',get:name=>({'X-Reliv-Growth-Client':client,'X-Reliv-Growth-Proxy-Key':secret}[name])},res,()=>{allowed=true;});
  return {...res,allowed};
 };
 assert.equal(request('a'.repeat(64),'proxy-test-secret').allowed,true);
 assert.equal(request('a'.repeat(64),'proxy-test-secret').allowed,true);
 assert.equal(request('a'.repeat(64),'proxy-test-secret').code,429);
 assert.equal(request('b'.repeat(64),'proxy-test-secret').allowed,true);
 assert.equal(request('c'.repeat(64),'wrong').allowed,true);
 assert.equal(request('d'.repeat(64),'wrong').allowed,true);
 assert.equal(request('e'.repeat(64),'wrong').code,429);
 now+=60001;assert.equal(request('a'.repeat(64),'proxy-test-secret').allowed,true);
});

test('registration is idempotent; codes exist on the server and public data excludes private fields',()=>{
 const {db,service:s}=fixture();try{
  const reg=key(),a=s.register(reg),again=s.register(reg);assert.equal(a.identity.userId,again.identity.userId);assert.equal(s.rows().length,1);
  assert.match(a.identity.referralCode,/^RLV-[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.throws(()=>s.member('RLV-ZZZZZ'),/not registered/);assert.throws(()=>s.member('test'),/Enter a code/);
  s.profile(user(s,a),{name:'Faizan',phone:'9163606455'});s.linkGoogle(user(s,a),{sub:'google-a',email:'private@example.com',name:'Faizan'},a.token);
  assert.equal(s.leaderboard().leaderboard.length,0);
  const friend=s.register(key());s.claim(user(s,friend),a.identity.referralCode);
  const publicJson=JSON.stringify(s.leaderboard());for(const privateValue of ['private@example.com','9163606455','google-a','registration_hash','email'])assert.ok(!publicJson.includes(privateValue));
  assert.equal(s.leaderboard().leaderboard[0].displayName,'Faizan');
 }finally{db.close();}
});
test('duplicate claims grant once; self-referrals, changing referrer and indirect cycles fail',()=>{
 const {db,service:s}=fixture();try{
  const a=s.register(key()),b=s.register(key()),c=s.register(key());
  assert.throws(()=>s.claim(user(s,a),a.identity.referralCode),/own referral/);
  const first=s.claim(user(s,b),a.identity.referralCode),again=s.claim(user(s,b),a.identity.referralCode);
  assert.equal(first.reward.grantId,again.reward.grantId);assert.equal(again.alreadyAccepted,true);assert.equal(s.snapshot(a.identity.userId).stats.acceptedCount,1);
  assert.throws(()=>s.claim(user(s,b),c.identity.referralCode),/already linked/);
  s.claim(user(s,c),b.identity.referralCode);assert.throws(()=>s.claim(user(s,a),c.identity.referralCode),/loop/);
  assert.equal(first.reward.voucher.status,'NOT_ENABLED');assert.equal(db.prepare('SELECT COUNT(*) n FROM growth_rewards').get().n,2);
  assert.ok(db.prepare("SELECT COUNT(*) n FROM growth_audit WHERE action='REFERRAL_REJECTED'").get().n>=3);
 }finally{db.close();}
});
test('qualification uses three server calendar days and Google verification, not browser claims',()=>{
 const {db,service:s,advance}=fixture();try{
  const a=s.register(key()),b=s.register(key());s.claim(user(s,b),a.identity.referralCode);
  for(let i=0;i<10;i++)s.activity(user(s,b),'water');assert.equal(s.snapshot(a.identity.userId).stats.qualifiedCount,0);
  advance();s.activity(user(s,b),'meal');advance();s.activity(user(s,b),'weight');assert.equal(s.snapshot(a.identity.userId).stats.qualifiedCount,0);
  s.linkGoogle(user(s,b),{sub:'google-b',email:'b@example.com',name:'Raj'},b.token);
  assert.equal(s.snapshot(a.identity.userId).stats.qualifiedCount,1);assert.equal(s.leaderboard().leaderboard[0].score,10);
  s.activity(user(s,b),'meal');assert.equal(s.leaderboard().leaderboard[0].score,10);
 }finally{db.close();}
});
test('Google recovery does not grant a second reward or preserve duplicate referral credit',()=>{
 const {db,service:s}=fixture();try{
  const freshKey=key(),a=s.register(key()),b=s.register(key()),fresh=s.register(freshKey);const google={sub:'b-stable',email:'b@example.com',name:'Raj'};
  s.claim(user(s,b),a.identity.referralCode);s.linkGoogle(user(s,b),google,b.token);s.claim(user(s,fresh),a.identity.referralCode);
  assert.equal(s.snapshot(a.identity.userId).stats.acceptedCount,2);
  const recovered=s.linkGoogle(user(s,fresh),google,fresh.token);assert.equal(recovered.identity.userId,b.identity.userId);
  assert.equal(user(s,fresh).id,b.identity.userId);assert.equal(s.snapshot(a.identity.userId).stats.acceptedCount,1);
  assert.equal(recovered.reward.grantId,s.snapshot(b.identity.userId).reward.grantId);
  const afterSessionExpiry=s.register(freshKey);assert.equal(afterSessionExpiry.identity.userId,b.identity.userId);
  assert.equal(s.adminOverview().overview.accepted,1);
 }finally{db.close();}
});
test('ledger survives process reopen and installation signals dedupe without claiming iOS downloads',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reliv-growth-'));let db;
 try{const path=join(dir,'growth.db');db=new Database(path);let s=new GrowthService({db});const a=s.register(key());
  s.signal(user(s,a),'pwa_appinstalled','Android');s.signal(user(s,a),'pwa_appinstalled','Android');s.signal(user(s,a),'pwa_standalone_launch','iOS');
  db.close();db=new Database(path);s=new GrowthService({db});assert.equal(user(s,a).id,a.identity.userId);
  const overview=s.adminOverview().overview;assert.equal(overview.pwaSignals.find(x=>x.type==='pwa_appinstalled').members,1);assert.equal(overview.retentionD7.percent,null);
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('admin requires both server secret and verified allowlisted Google; user cannot upload scores',async()=>{
 const db=new Database(':memory:');const app=express();app.use(express.json());
 app.use('/api/growth',createGrowthRouter({db,env:{GROWTH_ADMIN_PASSKEY:'server-test-key',GROWTH_ADMIN_EMAILS:'owner@example.com'},verifyGoogle:async token=>{if(token==='signed-owner')return {sub:'owner',email:'owner@example.com'};throw Object.assign(Error('Invalid credential'),{status:401});}}));
 app.use((err,_req,res,_next)=>res.status(err.status||500).json({ok:false,error:'Invalid request.'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/growth`;
 try{
  assert.equal((await fetch(base+'/admin?passkey=reliv-admin-2026',{headers:{Authorization:'Bearer owner@example.com'}})).status,403);
  assert.equal((await fetch(base+'/admin',{headers:{Authorization:'Bearer owner@example.com','X-Reliv-Admin-Key':'server-test-key'}})).status,401);
  assert.equal((await fetch(base+'/admin',{headers:{Authorization:'Bearer signed-owner','X-Reliv-Admin-Key':'server-test-key'}})).status,200);
  const reg=await (await fetch(base+'/referrals?action=register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registrationKey:key()})})).json();
  const headers={'Content-Type':'application/json',Authorization:`Bearer ${reg.token}`};
  const forge=await fetch(base+'/referrals?action=sync_user',{method:'POST',headers,body:JSON.stringify({qualifiedReferrals:9999,userId:reg.identity.userId})});assert.equal(forge.status,400);
  assert.equal((await fetch(base+'/referrals?action=claim',{method:'POST',headers,body:'null'})).status,400);
  const stats=await (await fetch(base+'/referrals?action=stats',{headers})).json();assert.equal(stats.stats.qualifiedCount,0);
 }finally{await new Promise(r=>server.close(r));db.close();}
});
test('Google verifier checks real signature, audience, issuer, expiry and verified email',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'key1'};const now=Date.now();
 const verifier=createGoogleVerifier({clientId:'client',clock:()=>now,fetcher:async()=>({ok:true,headers:{get:()=> 'max-age=300'},json:async()=>({keys:[jwk]})})});
 const claims={iss:'https://accounts.google.com',aud:'client',iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300,sub:'abc',email:'owner@example.com',email_verified:true};
 const jwt=patch=>{const a=Buffer.from(JSON.stringify({alg:'RS256',kid:'key1'})).toString('base64url'),b=Buffer.from(JSON.stringify({...claims,...patch})).toString('base64url');return a+'.'+b+'.'+sign('RSA-SHA256',Buffer.from(a+'.'+b),privateKey).toString('base64url');};
 assert.equal((await verifier(jwt({}))).sub,'abc');for(const patch of [{aud:'evil'},{iss:'evil'},{email_verified:false},{exp:1}])await assert.rejects(verifier(jwt(patch)));
 await assert.rejects(verifier(jwt({}).slice(0,-20)+'broken'));
});
