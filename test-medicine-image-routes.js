import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mountMedicineImages} from './src/services/medicineImageRoutes.js';
test('API proxy serves existing medicine files and missing photos cannot become kiosk HTML',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reliv-photo-'));
 const bytes=Buffer.from('89504e470d0a1a0a','hex');await writeFile(join(dir,'existing.png'),bytes);
 const app=express();mountMedicineImages(app,dir);app.use((_q,s)=>s.send('<html>kiosk</html>'));app.use((e,_q,s,_n)=>s.status(e.status||500).end());
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  for(const prefix of ['/medicine-images','/api/medicine-images']){
   const r=await fetch(base+prefix+'/existing.png');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/png/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);
  }
  assert.equal((await fetch(base+'/api/medicine-images/missing.png')).status,404);
  assert.equal((await fetch(base+'/api/medicine-images/%2e%2e%2fsecret')).status,403);
 } finally {server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
