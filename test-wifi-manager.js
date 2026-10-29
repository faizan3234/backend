import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { WifiManager, assertWifiIdle } from './src/services/wifiManager.js';
import { wifiMaintenanceGuard, createWifiRouter } from './src/routes/wifiRoutes.js';
test('missing helper never fabricates a connection', async () => {
 const manager = new WifiManager({ installed:false, request:async()=>{throw new Error('missing helper');} });
 await assert.rejects(manager.getStatus(), /missing/); assert.equal(manager.isMaintenance(), false);
});
test('switch blocks new writes immediately and rejects concurrent submissions', async () => {
 let finish; const manager = new WifiManager({ installed:true, request:()=>new Promise(resolve=>{finish=resolve;}) });
 const first=manager.connectNetwork({ssid:'phone'});assert.equal(manager.isMaintenance(),true);
 await assert.rejects(manager.connectNetwork({ssid:'phone'}), /already/);
 finish({phase:'scheduled',singleAdapter:true});await first;assert.equal(manager.isMaintenance(),true);
 manager.request=async()=>({singleAdapter:true,operation:{phase:'restored'}});await manager.getStatus();assert.equal(manager.isMaintenance(),false);
});
test('idle gate checks local sessions, paid work and ad activation grace', () => {
 const db = new Database(':memory:');
 db.exec('CREATE TABLE fulfillment_jobs(state TEXT); CREATE TABLE sessions(status TEXT, expires_at TEXT); CREATE TABLE payment_v2_requests(status TEXT, expires_at INTEGER); CREATE TABLE ad_payment_requests(status TEXT, expires_at INTEGER)');
 assert.doesNotThrow(()=>assertWifiIdle(db));
 for(const [table,columns,values] of [
  ['fulfillment_jobs','state',['IN_PROGRESS']],
  ['sessions','status,expires_at',['MEASURING',new Date(Date.now()+60000).toISOString()]],
  ['payment_v2_requests','status,expires_at',['ACTIVE',Date.now()+60000]],
  ['ad_payment_requests','status,expires_at',['ACTIVE',Date.now()-1000]],
 ]) {db.prepare(`INSERT INTO ${table} (${columns}) VALUES (${values.map(()=>'?')})`).run(...values);assert.throws(()=>assertWifiIdle(db),/Finish/);db.exec(`DELETE FROM ${table}`);}
 db.close();assert.throws(()=>assertWifiIdle(null),/not ready/);
});
test('maintenance allows owner recovery and reads but denies customer writes', () => {
 const guard=wifiMaintenanceGuard({isMaintenance:()=>true});
 let allowed=0,blocked=0;const res={status(code){assert.equal(code,503);return this;},json(){blocked++;}};
 for(const [method,path] of [['GET','/api/kits'],['POST','/api/wifi/restore'],['POST','/api/check-login'],['POST','/api/sessions']])guard({method,path},res,()=>allowed++);
 assert.equal(allowed,3);assert.equal(blocked,1);assert.throws(()=>createWifiRouter({manager:{}}),/authentication/);
});
test('active customer prevents helper invocation', async () => {
 let called=false;const manager=new WifiManager({installed:false,checkIdle:()=>{throw new Error('active visit');},request:async()=>{called=true;}});
 await assert.rejects(manager.connectNetwork({}),/active visit/);assert.equal(called,false);
});
