import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initializeDatabase, closeDatabase } from './src/database/db.js';
import adPayments, { AdPaymentService } from './src/services/adPaymentService.js';
import { createAdRouter } from './src/routes/adRoutes.js';
import { createAdminAuth } from './src/services/adminAuth.js';
import { decryptPackage, verifyPayloadSignature } from './src/services/paymentV2Crypto.js';
import { calculateExpectedAdPricePaise } from './payment-bridge-service/adPricing.js';
import { getAdInterval, setAdInterval } from './src/services/adSettingsService.js';

test('phone booking, signed payment, code-only activation and persistent admin timing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliv-ads-test-'));
  const db = initializeDatabase(':memory:');
  const signer = crypto.generateKeyPairSync('ed25519');
  const cloud = crypto.generateKeyPairSync('rsa', { modulusLength:2048 });
  adPayments._db = db; adPayments.pepper = 'synthetic-ad-pepper';
  adPayments._privateKey = signer.privateKey; adPayments._cloudPublicKey = cloud.publicKey;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata' }).format(new Date());
  const mediaPath = path.join(dir, 'prepared.webp'); fs.writeFileSync(mediaPath, 'synthetic-media');
  const campaign = (id, date = today) => {
    db.prepare(`INSERT INTO ad_campaigns(campaign_id,kiosk_id,price_paise,duration_days,status,created_at,updated_at,prepared_path,media_sha256,media_type)
      VALUES (?, ?, 5000, 1, 'PENDING_PAYMENT', ?, ?, ?, ?, 'image')`)
      .run(id,adPayments.kioskId,Date.now(),Date.now(),mediaPath,'a'.repeat(64));
    db.prepare(`INSERT INTO ad_campaign_venues(campaign_id,venue_id,start_date,end_date) VALUES (?,'gurukul',?,?)`).run(id,date,date);
  };
  const app = express(); app.use(express.json());
  const auth = createAdminAuth({ loadCredentials:async()=>({}), saveCredentials:async()=>{}, loadResets:async()=>({}), saveResets:async()=>{}, queueReset:async()=>{}, bootstrapEmail:'test@example.com', bootstrapPassword:'synthetic-password-long' });
  app.use(auth.protectWrites); auth.register(app); app.use('/api/ads', createAdRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); closeDatabase(); fs.rmSync(dir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, body, method = 'POST', token = '') => {
    const response = await fetch(base + url, { method, headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    return { status:response.status, body:await response.json() };
  };
  assert.equal(getAdInterval(db),5);
  assert.equal((await request('/api/ads/settings',{splashIntervalSeconds:15},'PUT')).status,401);
  const login = await request('/api/check-login',{email:'test@example.com',password:'synthetic-password-long'});
  assert.equal(login.status,200);
  assert.equal((await request('/api/ads/settings',{splashIntervalSeconds:15},'PUT',login.body.token)).body.splashIntervalSeconds,15);
  assert.equal(getAdInterval(db),15);
  assert.throws(()=>setAdInterval(7,db));
  assert.equal((await request('/api/ads/settings',{splashIntervalSeconds:'10'},'PUT',login.body.token)).status,400);
  assert.equal((await request('/api/ads/active-playlist',undefined,'GET')).body.splashIntervalSeconds,15);
  assert.equal((await request('/api/ads/config',undefined,'GET')).body.venues.length,1);
  assert.equal((await request('/api/ads/drafts',{targetVenueIds:['beeu-resorts'],durationDays:1})).status,400);
  campaign('AD-TEST-FIRST'); campaign('AD-TEST-NEWER');
  const first = await request('/api/ads/AD-TEST-FIRST/confirm-booking',{});
  assert.equal(first.status,200); assert.match(first.body.paymentUrl,/^https:\/\/reliv7.vercel.app\/pay#p=/);
  assert.equal((await request('/api/ads/AD-TEST-FIRST/confirm-booking',{})).body.paymentUrl,first.body.paymentUrl);
  const signed = decryptPackage(first.body.paymentUrl.split('#p=')[1],cloud.privateKey);
  assert.ok(verifyPayloadSignature(signed.payload,signed.signature,signer.publicKey));
  assert.equal(signed.payload.amount,calculateExpectedAdPricePaise(signed.payload.adCampaign));
  assert.equal(first.body.amountPaise,signed.payload.amount);
  assert.equal(first.body.confirmationCode,undefined);
  await request('/api/ads/AD-TEST-NEWER/confirm-booking',{});
  const activation = await request('/api/ads/activate',{code:signed.payload.confirmationCode});
  assert.equal(activation.body.campaignId,'AD-TEST-FIRST'); assert.equal(activation.body.status,'ACTIVE');
  assert.equal((await request('/api/ads/activate',{code:signed.payload.confirmationCode})).body.status,'ACTIVE');
  assert.equal(db.prepare('SELECT status FROM ad_campaigns WHERE campaign_id=?').get('AD-TEST-NEWER').status,'PENDING_PAYMENT');
  const playlist = (await request('/api/ads/active-playlist',undefined,'GET')).body;
  assert.deepEqual(playlist.ads.map(ad=>ad.campaignId),['AD-TEST-FIRST']);
  fs.unlinkSync(mediaPath);
  assert.equal((await request('/api/ads/active-playlist',undefined,'GET')).body.ads.length,0);
  const wrong = Array.from({length:10000},(_,n)=>String(n).padStart(4,'0')).find(code=>!adPayments.activationCandidates().some(row=>adPayments.matchesCode(row,code)));
  assert.equal((await request('/api/ads/activate',{code:wrong})).status,400);
  assert.equal((await request('/api/ads/activate',{code:signed.payload.confirmationCode})).status,200);
  assert.equal(JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get('adActivationAttempts').value).count,1,'a known valid code cannot reset the brute-force budget');
  for (let i=0;i<4;i++) assert.equal((await request('/api/ads/activate',{code:wrong})).status,400);
  assert.equal((await request('/api/ads/activate',{code:signed.payload.confirmationCode})).status,429);
  const restarted = new AdPaymentService({db,pepper:'synthetic-ad-pepper'});
  assert.equal(restarted.consumeActivationAttempt(),false,'rate limit survives service recreation');
  db.prepare('DELETE FROM settings WHERE key=?').run('adActivationAttempts');
  // Expired payment URLs cannot accidentally charge the same campaign twice.
  db.prepare('UPDATE ad_payment_requests SET expires_at=? WHERE campaign_id=?').run(Date.now()-1000,'AD-TEST-NEWER');
  assert.equal((await request('/api/ads/AD-TEST-NEWER/confirm-booking',{})).status,400);
  // Paid code grace keeps the media even if the original draft is over two hours old.
  db.prepare('UPDATE ad_campaigns SET created_at=? WHERE campaign_id=?').run(Date.now()-10800000,'AD-TEST-NEWER');
  await request('/api/ads/active-playlist',undefined,'GET');
  assert.equal(db.prepare('SELECT status FROM ad_campaigns WHERE campaign_id=?').get('AD-TEST-NEWER').status,'PENDING_PAYMENT');
  // A booking awaiting payment reserves capacity, and drafts alone do not.
  for (let i=0;i<7;i++) campaign('AD-CAPACITY-'+i);
  for (let i=0;i<6;i++) assert.equal((await request('/api/ads/AD-CAPACITY-'+i+'/confirm-booking',{})).status,200);
  assert.equal((await request('/api/ads/AD-CAPACITY-6/confirm-booking',{})).status,409);
  const codes = adPayments.activationCandidates().map(row => decryptPackage(row.encrypted_package,cloud.privateKey).payload.confirmationCode);
  assert.equal(new Set(codes).size,codes.length,'all eligible activation codes are unique');
  // Activation feedback must match the playlist's date AND daily-hour filter.
  campaign('AD-HOURS');
  const nextEnd = new Date(Date.now()+2*86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  db.prepare('UPDATE ad_campaigns SET duration_days=3,price_paise=11700 WHERE campaign_id=?').run('AD-HOURS');
  db.prepare('UPDATE ad_campaign_venues SET end_date=? WHERE campaign_id=?').run(nextEnd,'AD-HOURS');
  const clock = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const minute = Number(clock.find(p=>p.type==='hour').value)*60 + Number(clock.find(p=>p.type==='minute').value);
  db.prepare('UPDATE ad_campaign_venues SET is_all_day=0,daily_start_minute=?,daily_end_minute=? WHERE campaign_id=?')
    .run(minute === 0 ? 1 : 0, minute === 0 ? 2 : minute, 'AD-HOURS');
  const hoursPayment = adPayments.createPaymentRequest('AD-HOURS');
  const hoursCode = decryptPackage(hoursPayment.paymentUrl.split('#p=')[1],cloud.privateKey).payload.confirmationCode;
  assert.equal(adPayments.verifyCodeOnly(hoursCode).status,'SCHEDULED','outside booked hours must not promise the ad is already playing');
  const expiredDay = new Date(Date.now()-86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
  campaign('AD-ENDED',expiredDay);
  assert.equal((await request('/api/ads/AD-ENDED/confirm-booking',{})).body.code,'AD_SCHEDULE_ENDED','do not start a payment for an elapsed campaign');
  const endedPayment = adPayments.createPaymentRequest('AD-ENDED');
  const endedCode = decryptPackage(endedPayment.paymentUrl.split('#p=')[1],cloud.privateKey).payload.confirmationCode;
  const ended = adPayments.verifyCodeOnly(endedCode);
  assert.equal(ended.ok,false);
  assert.match(ended.message,/Do not pay again/);
  assert.equal(db.prepare('SELECT status FROM ad_payment_requests WHERE request_id=?').get(endedPayment.requestId).status,'ACTIVE','retain ended paid request for administrator recovery');
});
