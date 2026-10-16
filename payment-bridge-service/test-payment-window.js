import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPaymentWindow} from './services/paymentWindow.js';
const now=Date.UTC(2026,9,16,16,0,0);
const payload={requestId:'REQ-TEST',kioskId:'RELIV-001',issuedAt:now,expiresAt:now+300000};
test('fresh QR and grace window work; old QR stays rejected with diagnostic times',()=>{
 checkPaymentWindow(payload,now);checkPaymentWindow(payload,now+330000);
 assert.throws(()=>checkPaymentWindow(payload,now+330001),e=>e.code==='REQUEST_EXPIRED'&&e.paymentTiming.kioskIssuedAt===now&&e.message.includes('clock'));
});
test('offline Pi behind and ahead have actionable errors; paid recovery survives expiry',()=>{
 const behind={...payload,issuedAt:now-86400000,expiresAt:now-86100000};
 assert.throws(()=>checkPaymentWindow(behind,now),{code:'REQUEST_EXPIRED'});
 assert.throws(()=>checkPaymentWindow({...payload,issuedAt:now+60000,expiresAt:now+360000},now),{code:'KIOSK_CLOCK_AHEAD'});
 checkPaymentWindow(behind,now,30000,true);
});
test('malformed, backwards, string and non-finite validity windows fail closed',()=>{
 for(const fields of [{issuedAt:NaN},{expiresAt:Infinity},{issuedAt:String(now)},{expiresAt:now},{issuedAt:0},{expiresAt:8640000000000001}])assert.throws(()=>checkPaymentWindow({...payload,...fields},now),{code:'INVALID_PAYMENT_WINDOW'});
});
