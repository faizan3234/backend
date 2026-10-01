import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalSpeechHandler } from './src/routes/localSpeech.js';
import { dispensingSnapshot } from './src/services/dispensingSnapshot.js';
import { initializeDatabase, getDb, closeDatabase } from './src/database/db.js';
import fulfillment from './src/services/fulfillmentManager.js';

function response() {
  const res = new EventEmitter();
  res.set = () => res; res.type = () => res;
  res.status = n => { res.code = n; return res; };
  res.send = res.json = body => { res.body = body; res.emit('done'); return res; };
  return res;
}
test('local speech uses fixed executable and stdin, returns WAV; rejects language/input injection', async () => {
  let command, input = '';
  const handler = createLocalSpeechHandler({spawnProcess:(...args)=>{
    command=args;
    const child=new EventEmitter(); child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.kill=()=>{};
    child.stdin.on('data',c=>input+=c);
    child.stdin.on('finish',()=>{ const wav=Buffer.alloc(44); wav.write('RIFF'); child.stdout.emit('data',wav); child.emit('close',0); });
    return child;
  }});
  const res=response(); const done=new Promise(resolve=>res.once('done',resolve));
  handler({body:{language:'bn',text:'--help; $(not-a-command) বাংলা'}},res);
  await done;
  assert.equal(command[0],'espeak-ng'); assert.equal(command[2].shell,false);
  assert.equal(command[1].includes(input),false); assert.match(input,/বাংলা/);
  assert.equal(res.body.toString('ascii',0,4),'RIFF');
  const bad=response(); handler({body:{language:'../../etc',text:'x'}},bad); assert.equal(bad.code,400);
  const long=response(); handler({body:{language:'en',text:'x'.repeat(1601)}},long); assert.equal(long.code,400);
});
test('local speech failures, cancellation and timeout release the active slot', async () => {
  const children=[];
  const handler=createLocalSpeechHandler({timeoutMs:10,spawnProcess:()=>{
    const c=new EventEmitter(); c.stdin=new PassThrough(); c.stdout=new PassThrough(); c.kill=()=>{c.killed=true;}; children.push(c); return c;
  }});
  const body={text:'test',language:'hi'};
  const a=response(), b=response(), blocked=response();
  handler({body},a); handler({body},b); handler({body},blocked);
  assert.equal(blocked.code,429);
  a.destroyed=true; a.emit('close'); assert.equal(children[0].killed,true);
  const c=response(); handler({body},c); children[2].emit('error',new Error('ENOENT')); assert.equal(c.code,503);
  await new Promise(resolve=>b.once('done',resolve)); assert.equal(b.code,504);
});
test('status needs real completed jobs; old session flags cannot invent delivery or report readiness', () => {
  const s={session_id:'S',service_type:'MEDICINE',status:'COMPLETED',dispense_status:'COMPLETED'};
  const tx={status:'VERIFIED',fulfilled:1};
  assert.equal(dispensingSnapshot(s,tx,[]).status,'dispense_waiting');
  assert.equal(dispensingSnapshot(s,tx,[{state:'COMPLETED'},{state:'IN_PROGRESS'}]).status,'dispensing');
  assert.equal(dispensingSnapshot(s,tx,[{state:'MANUAL_REVIEW_REQUIRED'}]).status,'dispense_review_required');
  assert.equal(dispensingSnapshot(s,tx,[{state:'COMPLETED'}]).status,'dispense_complete');
  assert.notEqual(dispensingSnapshot({...s,service_type:'HEALTH_CHECKUP',report_status:'NOT_REQUIRED'},null,[]).status,'report_ready');
});
test('durable claim precedes MQTT, early ACK survives PUBACK, duplicates and uncertain failures never republish', async () => {
  const dir=mkdtempSync(join(tmpdir(),'reliv-ack-'));
  initializeDatabase(join(dir,'test.db')); const db=getDb();
  try {
    db.prepare("INSERT INTO sessions(session_id,status,expires_at) VALUES('S','FULFILLMENT',datetime('now','+1 hour'))").run();
    db.prepare("INSERT INTO transactions(transaction_id,session_id,type,amount,status) VALUES('T','S','MEDICINE',100,'VERIFIED')").run();
    db.prepare("INSERT INTO inventory(kit_id,name,price,quantity,motor_id) VALUES('K','Test kit',100,10,1)").run();
    const insert=id=>{
      db.prepare("INSERT INTO transactions(transaction_id,session_id,type,amount,status) VALUES(?,'S','MEDICINE',100,'VERIFIED')").run('T'+id);
      db.prepare("INSERT INTO fulfillment_jobs(job_id,session_id,transaction_id,kit_id,quantity,motor_id,state) VALUES(?,'S',?,'K',1,1,'PENDING')").run(id,'T'+id);
    };
    insert('J1'); let publishCount=0, callback;
    fulfillment.setMqttClient({connected:true,publish(topic,payload,opts,cb){
      publishCount++; callback=cb;
      assert.equal(fulfillment.getJobStatus('J1').state,'IN_PROGRESS'); assert.equal(opts.retain,false);
    }});
    const first=fulfillment.startDispensing('J1');
    assert.equal(await fulfillment.startDispensing('J1'),false);
    assert.equal(await fulfillment.markCompleted('J1',{jobId:'wrong',kitId:'K',quantity:1}),false);
    for (const extra of [{status:'IN_PROGRESS'}, {status:'received'}, {status:null}, {motor:'invalid'}, {motor:1.5}, {success:'false'}, {jobId:''}]) {
      assert.equal(await fulfillment.markCompleted('J1',{jobId:'J1',kitId:'K',quantity:1,...extra}),false);
      assert.equal(fulfillment.getJobStatus('J1').state,'IN_PROGRESS');
    }
    assert.equal(await fulfillment.markCompleted('J1',null),false);
    assert.equal(await fulfillment.markCompleted('J1',{jobId:'J1',kitId:'K',quantity:1,status:'SUCCESS'}),true);
    callback(null); await first;
    assert.equal(fulfillment.getJobStatus('J1').state,'COMPLETED'); assert.equal(publishCount,1);
    insert('J2'); fulfillment.setMqttClient({connected:true,publish(t,p,o,cb){cb(new Error('delivery uncertain'));}});
    await assert.rejects(fulfillment.startDispensing('J2'),/uncertain/);
    assert.equal(fulfillment.getJobStatus('J2').state,'MANUAL_REVIEW_REQUIRED');
    assert.equal(await fulfillment.startDispensing('J2'),false);
    insert('J3'); fulfillment.setMqttClient({connected:false,publish(){throw new Error('must not publish');}});
    await assert.rejects(fulfillment.startDispensing('J3'),/disconnected/);
    assert.equal(fulfillment.getJobStatus('J3').state,'PENDING');
    db.prepare("UPDATE fulfillment_jobs SET state='IN_PROGRESS' WHERE job_id='J3'").run();
    await fulfillment.markFailed('J3','sensor uncertain');
    assert.equal(fulfillment.getJobStatus('J3').state,'MANUAL_REVIEW_REQUIRED');
  } finally { closeDatabase(); rmSync(dir,{recursive:true,force:true}); }
});
