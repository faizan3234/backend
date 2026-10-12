import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {initializeDatabase,getDb,closeDatabase} from './src/database/db.js';
test('invalid database is preserved and startup fails instead of silently creating an empty kiosk',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reliv-preserve-'));const path=join(dir,'kiosk.db');
 const original=Buffer.from('synthetic damaged database - retain for manual recovery');writeFileSync(path,original);
 try {
  assert.throws(()=>initializeDatabase(path));assert.deepEqual(readFileSync(path),original);
  assert.deepEqual(readdirSync(dir),['kiosk.db']);assert.throws(()=>getDb(),/not initialized/);
  // Failure does not leave a broken singleton preventing another valid database opening.
  const db=initializeDatabase(join(dir,'isolated-test.db'));assert.equal(db.prepare('SELECT 1 AS ok').get().ok,1);
 } finally {closeDatabase();rmSync(dir,{recursive:true,force:true});}
});
