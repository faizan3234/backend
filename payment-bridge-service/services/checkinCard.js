import PDFDocument from 'pdfkit';
import { setupPdfFonts } from './receiptPdfBuilder.js';
export function validateStoryCard(value) {
 if(value===null||value===undefined)return null;
 const invalid=()=>{const e=new Error('Both people must agree to the story card and provide nicknames of 1–20 characters.');e.code='INVALID_STORY_CARD';throw e;};
 if(typeof value!=='object'||Array.isArray(value)||value.consent!==true||!['friends','couple'].includes(value.relationship))return invalid();
 const names=[value.alias,value.partner].map(name=>typeof name==='string'?name.trim():'');
 if(names.some(name=>!name||[...name].length>20||/[\u0000-\u001f\u007f<>]/u.test(name)))return invalid();
 return {alias:names[0],partner:names[1],relationship:value.relationship,consent:true};
}
export function generateCheckinCardPdf(value) {
 const card=validateStoryCard(value);
 if(!card)throw new Error('Story card required');
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({size:[540,960],margin:45}),parts=[];
  doc.on('data',c=>parts.push(c));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);
  const fonts=setupPdfFonts(doc),normal=fonts?.fontR||'Helvetica',bold=fonts?.fontB||'Helvetica-Bold';
  doc.rect(0,0,540,960).fill('#172033');doc.circle(520,40,170).fill('#FF641A');
  doc.font(bold).fontSize(30).fillColor('#FDBA74').text('RELIV',45,65);
  doc.fillColor('white').fontSize(39).text('BETTER HABITS.\nTOGETHER.',45,180,{lineGap:12});
  doc.fontSize(18).fillColor('#FDE68A').text(card.relationship==='couple'?'OUR COUPLE CHECK-IN':'OUR FRIEND CHECK-IN',45,325);
  doc.roundedRect(40,385,460,255,16).fill('#34375B');
  doc.font(bold).fontSize(28).fillColor('white').text(card.alias,60,420,{width:420}).text('&',60,465).text(card.partner,60,510,{width:420});
  doc.font(normal).fontSize(17).fillColor('#FED7AA').text('We are making time for our health.',60,590,{width:420});
  doc.font(bold).fontSize(25).fillColor('white').text('THE WIN: SHOWING UP.',45,730);
  doc.font(normal).fontSize(15).text('A shared intention. No medical rankings.\nChoose a habit. Encourage each other.',45,782,{lineGap:10});
  doc.font(bold).fontSize(20).fillColor('#FDBA74').text('#RelivTogether',45,860);doc.end();
 });
}
