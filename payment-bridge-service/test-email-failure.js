import test from 'node:test';
import assert from 'node:assert/strict';
import { emailFailure } from './services/emailFailure.js';
test('Gmail rejected login is a sender problem without provider details',()=>{
 for(const cause of [{code:'EAUTH',message:'private details'},{responseCode:535},{message:'Invalid login: 535-5.7.8 Username and Password not accepted secret'}]){
  const result=emailFailure(cause);
  assert.equal(result.code,'EMAIL_AUTH_FAILED');assert.match(result.message,/administrator/);
  assert.doesNotMatch(result.message,/535|secret|private/);assert.match(result.message,/do not pay again/);
 }
});
test('temporary SMTP failure permits delivery retry and never suggests another charge',()=>{
 const result=emailFailure({code:'ETIMEDOUT',message:'internal host'});
 assert.equal(result.code,'EMAIL_SEND_FAILED');assert.doesNotMatch(result.message,/internal host/);
});
