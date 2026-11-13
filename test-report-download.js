import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// Exercise the actual registered route, including early auth returns and sendFile.
const source = readFileSync(new URL('./server.js', import.meta.url),'utf8');
const start = source.indexOf('app.get("/api/sessions/:sessionId/report/download",');
const end = source.indexOf('\n});',start)+4;
async function run({token,profile=true,status='READY'}={}) {
 let handler;const result={};
 const context={app:{get:(_path,fn)=>{handler=fn;}},pdfGenerator:{getReportBySession:()=>({pdf_path:'/report.pdf'})},getDb:()=>({prepare:()=>({get:()=>profile?{exists:1}:null})}),
  privateHealthJourney:(_db,_id,value)=>value==='private-proof'?{}:null,
  getAuthorizedHealthReportContext:()=>({ok:true}),sessionManager:{getSession:()=>({report_status:status})},log:{error:()=>{}}};
 vm.runInNewContext(source.slice(start,end),context);
 const res={status(code){result.status=code;return this;},json(data){result.body=data;return this;},set(k,v){result[k]=v;},sendFile(path){result.file=path;}};
 await handler({params:{sessionId:'S'},get:()=>token},res);return result;
}
test('paid QR session ID alone cannot download a private PDF',async()=>{
 for(const token of [undefined,'wrong']){const r=await run({token});assert.equal(r.status,403);assert.equal(r.file,undefined);}
});
test('private credential can download READY and EMAILED PDFs without public caching',async()=>{
 for(const status of ['READY','EMAILED']){const r=await run({token:'private-proof',status});assert.equal(r.file,'/report.pdf');assert.equal(r['Cache-Control'],'private, no-store');}
 assert.equal((await run({token:'private-proof',status:'GENERATING'})).status,409);
 assert.equal((await run({profile:false})).file,'/report.pdf');
});
