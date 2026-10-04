import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { storySummary } from './services/storySummary.js';
import { validateStoryCard, generateCheckinCardPng } from './services/checkinCard.js';
const sample={scanNumber:4,patient:{age:32,gender:'male'},vitals:{weight:65.4,height:172.3}};
test('signed-snapshot score is optional, finite and retains visit number',()=>{
 assert.deepEqual(storySummary(sample),{score:91,scanNumber:4});
 for(const v of [undefined,{}, {patient:{age:32,gender:'male'},vitals:{weight:Infinity,height:170}}])assert.equal(storySummary(v).score,null);
});
test('solo card requires explicit consent and cannot accept a client score',()=>{
 const card={relationship:'solo',alias:'Rahul',consent:true,score:100};
 assert.deepEqual(validateStoryCard(card),{relationship:'solo',alias:'Rahul',partner:'',consent:true});
 assert.throws(()=>validateStoryCard({...card,consent:false}));
 assert.throws(()=>validateStoryCard({...card,alias:'<script>'}));
 assert.throws(()=>validateStoryCard({...card,relationship:'friends'}));
});
test('individual and together cards render as portrait PNG',async()=>{
 for(const relationship of ['solo','friends','couple']) {
  const png=await generateCheckinCardPng({relationship,alias:'Rahul',partner:'Priya',consent:true},storySummary(sample));
  const metadata=await sharp(png).metadata();
  assert.equal(metadata.width,1080);assert.equal(metadata.height,1920);assert.equal(metadata.format,'png');
 }
});
