import test from 'node:test';
import assert from 'node:assert/strict';
import baseManager from '../src/services/fulfillmentManager.js';
import {dispenseReceipt} from '../src/services/dispenseReceipt.js';
const ack = {jobId:'J',kitId:'K',motor:2,quantity:1,status:'SUCCESS',success:true};
const job = {job_id:'J',kit_id:'K',motor_id:2,quantity:1,state:'COMPLETED',esp32_ack_payload:JSON.stringify(ack)};
test('only exact durable results receive a receipt; replay is idempotent',()=>{
 assert.equal(dispenseReceipt(job,ack).recorded,true);
 assert.deepEqual(dispenseReceipt(job,ack),dispenseReceipt(job,ack));
 for (const change of [{jobId:'other'},{kitId:'other'},{motor:1},{quantity:2},{status:'ERROR'},{success:false}]) assert.equal(dispenseReceipt(job,{...ack,...change}),null);
 for (const state of ['PENDING','IN_PROGRESS','FAILED']) assert.equal(dispenseReceipt({...job,state},ack),null);
 assert.equal(dispenseReceipt({...job,esp32_ack_payload:null},ack),null);
});
test('recorded physical uncertainty is acknowledged without converting it to success',()=>{
 const error={...ack,status:'ERROR',success:false,receiptProtocol:2};
 assert.equal(dispenseReceipt({...job,state:'MANUAL_REVIEW_REQUIRED',esp32_ack_payload:JSON.stringify(error)},error).status,'ERROR');
 assert.equal(dispenseReceipt({...job,state:'MANUAL_REVIEW_REQUIRED'},error),null);
});
// Execute the actual manager method with a DB read stub, no production database.
test('completed job rejects mismatched and failed ACKs before accepting replay',()=>{
 const manager=Object.create(baseManager);
 Object.defineProperty(manager,'db',{value:{prepare:()=>({get:()=>job,run:()=>{throw Error('No duplicate writes allowed');}})}});
 assert.equal(manager.markCompleted('J',ack),true);
 for(const bad of [{},{...ack,kitId:'wrong'},{...ack,motor:3},{...ack,quantity:2},{...ack,jobId:'wrong'},{...ack,status:'ERROR',success:false}]) assert.equal(manager.markCompleted('J',bad),false);

});

