import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDatabase } from './src/database/db.js';
import sessionManager from './src/services/sessionManager.js';
import { attachHealthProfile, privateHealthJourney } from './src/services/healthProfiles.js';

test('private trends contain only paid scans for the PIN verified profile', () => {
  const db = initializeDatabase(':memory:');
  sessionManager.initialize();
  function visit(mode, pin, systolic, paid = true) {
    const session = sessionManager.createSession();
    const result = attachHealthProfile(db, sessionManager, session.session_id, {
      mode, name: ' Rahul Kumar ', pin, age: 26, gender: 'male', email: ''
    });
    db.prepare(`UPDATE sessions SET service_type='HEALTH_CHECKUP', payment_status=?, report_status=?, health_data=? WHERE session_id=?`)
      .run(paid ? 'VERIFIED' : 'PENDING', paid ? 'READY' : 'NOT_REQUIRED', JSON.stringify({vitals:{systolic,diastolic:80,oxygen:98,impedance:500}}), session.session_id);
    return { sessionId: session.session_id, token: result.accessToken };
  }
  const first = visit('new','123456',120);
  const second = visit('returning','123456',124);
  const someoneElse = visit('new','654321',140);
  visit('returning','123456',200,false);
  assert.equal(privateHealthJourney(db, second.sessionId, first.token), null);
  assert.equal(privateHealthJourney(db, second.sessionId, 'no-token'), null);
  const journey = privateHealthJourney(db, second.sessionId, second.token);
  assert.equal(journey.scanCount, 2);
  assert.deepEqual(journey.history.map(x => x.systolic), [120,124]);
  assert.equal('impedance' in journey.history[0], false);
  assert.deepEqual(journey.history[0].patient,{age:26,gender:'male'});
  assert.equal(journey.history[0].patient.name,undefined);
  assert.equal(privateHealthJourney(db, someoneElse.sessionId, someoneElse.token).scanCount, 1);
  assert.equal(db.prepare('SELECT count(*) AS total FROM health_profiles').get().total, 2);
  assert.equal(db.prepare('SELECT count(*) AS total FROM health_profiles WHERE pin_hash IN (?, ?)').get('123456','654321').total, 0);
  assert.equal(JSON.stringify(sessionManager.getSession(second.sessionId).customer_data).includes('123456'), false);
  const failed = sessionManager.createSession();
  for (let attempt = 0; attempt < 5; attempt++) assert.throws(() => attachHealthProfile(db, sessionManager, failed.session_id, { mode:'returning', name:'Rahul Kumar', pin:'999999' }), /Name or PIN/);
  assert.throws(() => attachHealthProfile(db, sessionManager, failed.session_id, { mode:'returning', name:'Rahul Kumar', pin:'123456' }), /Too many attempts/);
});


test('long health journeys retain the latest scan and the full paid scan count', () => {
  const db = initializeDatabase(':memory:'); sessionManager.initialize();
  const first=sessionManager.createSession();
  const result=attachHealthProfile(db,sessionManager,first.session_id,{mode:'new',name:'Long Journey',pin:'928341',age:30,gender:'female'});
  const access=db.prepare('SELECT * FROM health_profile_sessions WHERE session_id=?').get(first.session_id);
  let last;
  for(let i=0;i<105;i++) {
    last=sessionManager.createSession();
    db.prepare('INSERT INTO health_profile_sessions(session_id,profile_id,access_hash) VALUES(?,?,?)').run(last.session_id,access.profile_id,access.access_hash);
    db.prepare("UPDATE sessions SET service_type='HEALTH_CHECKUP',payment_status='VERIFIED',report_status='READY',health_data=? WHERE session_id=?").run(JSON.stringify({vitals:{systolic:100+i}}),last.session_id);
  }
  const journey=privateHealthJourney(db,last.session_id,result.accessToken);
  assert.equal(journey.scanCount,105);
  assert.equal(journey.history.length,100);
  assert.equal(journey.history[0].systolic,105);
  assert.equal(journey.history.at(-1).systolic,204);
});


test('fourth and seventh private visits keep their number after email and repeated reads', () => {
  const db=initializeDatabase(':memory:'); sessionManager.initialize();
  const visits=[];
  for(let n=1;n<=7;n++) {
    const session=sessionManager.createSession();
    const identity=attachHealthProfile(db,sessionManager,session.session_id,{mode:n===1?'new':'returning',name:'Visit Counter',pin:'672931',age:35,gender:'male'});
    db.prepare("UPDATE sessions SET service_type='HEALTH_CHECKUP',payment_status='VERIFIED',report_status=?,health_data=? WHERE session_id=?").run(n%2?'EMAILED':'READY',JSON.stringify({vitals:{systolic:138,diastolic:77,weight:65}}),session.session_id);
    visits.push({id:session.session_id,token:identity.accessToken});
  }
  for(const n of [4,7]) {
    const visit=visits[n-1];
    for(let repeat=0;repeat<3;repeat++) {
      const journey=privateHealthJourney(db,visit.id,visit.token);
      assert.equal(journey.scanCount,n);
      assert.deepEqual(journey.history.map(row=>row.scanNumber),Array.from({length:n},(_,i)=>i+1));
    }
  }
});

test('temporary review opens only latest paid report, creates no scans, expires and switches off', async () => {
 const {openLatestPaidReport}=await import('./src/services/healthProfiles.js');
 const {getLocalReportScanNumber}=await import('./src/services/reportVisits.js');
 const previous=process.env.RELIV_REPORT_REVIEW_MODE;process.env.RELIV_REPORT_REVIEW_MODE='true';
 try {
  const db=initializeDatabase(':memory:');sessionManager.initialize();let last,normalToken;
  for(let i=1;i<=7;i++){
   const session=sessionManager.createSession();
   const identity=attachHealthProfile(db,sessionManager,session.session_id,{mode:i===1?'new':'returning',name:'Review Person',pin:'423189',age:30,gender:'male'});
   db.prepare("UPDATE sessions SET service_type='HEALTH_CHECKUP',payment_status='VERIFIED',report_status='READY',health_data=? WHERE session_id=?").run(JSON.stringify({vitals:{weight:60+i,height:170}}),session.session_id);
   last=session.session_id;normalToken=identity.accessToken;
  }
  const other=sessionManager.createSession();attachHealthProfile(db,sessionManager,other.session_id,{mode:'new',name:'Review Person',pin:'183924',age:35,gender:'female'});
  const unpaid=sessionManager.createSession();attachHealthProfile(db,sessionManager,unpaid.session_id,{mode:'returning',name:'Review Person',pin:'423189'});
  const before=db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const result=openLatestPaidReport(db,{name:'review person',pin:'423189'});
  assert.equal(result.sessionId,last);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,before);
  assert.equal(privateHealthJourney(db,last,result.accessToken).scanCount,7);
  assert.equal(getLocalReportScanNumber(db,last),7);
  assert.equal(privateHealthJourney(db,other.session_id,result.accessToken),null);
  assert.throws(()=>openLatestPaidReport(db,{name:'Review Person',pin:'183924'}),e=>e.code==='NO_SAVED_REPORT');
  assert.throws(()=>openLatestPaidReport(db,{name:'Review Person',pin:'000000'}),e=>e.status===401);
  process.env.RELIV_REPORT_REVIEW_MODE='false';
  assert.equal(privateHealthJourney(db,last,result.accessToken),null);
  assert.throws(()=>openLatestPaidReport(db,{name:'Review Person',pin:'423189'}),e=>e.status===404);
  assert.equal(privateHealthJourney(db,last,normalToken).scanCount,7,'normal paid access survives feature off');
  process.env.RELIV_REPORT_REVIEW_MODE='true';db.prepare('UPDATE health_report_review_access SET expires_at=0').run();
  assert.equal(privateHealthJourney(db,last,result.accessToken),null);
  for(let i=0;i<4;i++)assert.throws(()=>openLatestPaidReport(db,{name:'Review Person',pin:'000000'}),e=>e.status===401);
  assert.throws(()=>openLatestPaidReport(db,{name:'Review Person',pin:'423189'}),e=>e.status===429);
 } finally {if(previous===undefined)delete process.env.RELIV_REPORT_REVIEW_MODE;else process.env.RELIV_REPORT_REVIEW_MODE=previous;}
});
