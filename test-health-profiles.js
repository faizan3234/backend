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
