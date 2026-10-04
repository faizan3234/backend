import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
export function validateStoryCard(value) {
 if(value===null||value===undefined)return null;
 const invalid=()=>{const e=new Error('Agree to sharing and provide nicknames of 1–20 characters for everyone on the card.');e.code='INVALID_STORY_CARD';throw e;};
 if(typeof value!=='object'||Array.isArray(value)||value.consent!==true||!['solo','friends','couple'].includes(value.relationship))return invalid();
 const names=(value.relationship==='solo'?[value.alias]:[value.alias,value.partner]).map(name=>typeof name==='string'?name.trim():'');
 if(names.some(name=>!name||[...name].length>20||/[\u0000-\u001f\u007f<>]/u.test(name)))return invalid();
 return {alias:names[0],partner:names[1]||'',relationship:value.relationship,consent:true};
}
const xml = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
// 9:16 social image, generated locally on the bridge. No external render service.
export async function generateCheckinCardPng(value, summary = null) {
 const card=validateStoryCard(value);
 if(!card)throw new Error('Story card required');
 const logo=await sharp(fileURLToPath(new URL('../assets/reliv.png',import.meta.url))).trim({threshold:20}).resize(330,130,{fit:'contain',background:'#ffffff'}).png().toBuffer();
 const solo=card.relationship==='solo';
 const score=typeof summary?.score==='number' && Number.isFinite(summary.score)?Math.max(0,Math.min(100,Math.round(summary.score))):null;
 const nameSize = name => [...name].length>14?42:54;
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
 <defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#172033"/><stop offset="1" stop-color="#34375b"/></linearGradient></defs>
 <rect width="1080" height="1920" fill="url(#bg)"/><circle cx="1050" cy="60" r="300" fill="#ff641a"/>
 <g font-family="DejaVu Sans, sans-serif" fill="white">
 <text x="90" y="405" font-size="78" font-weight="bold">BETTER HABITS.</text><text x="90" y="505" font-size="78" font-weight="bold">${solo?'FOR ME.':'TOGETHER.'}</text>
 <text x="90" y="650" font-size="32" fill="#fde68a">${solo?'MY RELIV CHECK-IN':card.relationship==='couple'?'OUR COUPLE CHECK-IN':'OUR FRIEND CHECK-IN'}</text>
 <rect x="80" y="740" width="920" height="490" rx="36" fill="#414567"/>
 <text x="120" y="845" font-size="${nameSize(card.alias)}" font-weight="bold">${xml(card.alias)}</text>
 <text x="120" y="925" font-size="46" fill="#fdba74">${solo?'': '&amp;'}</text>
 <text x="120" y="1015" font-size="${nameSize(card.partner)}" font-weight="bold">${solo?(score===null?'Check-in complete':score+' / 100'):xml(card.partner)}</text>
 <text x="120" y="1140" font-size="30" fill="#fed7aa">${solo?'Body-score estimate · not a diagnosis':'We are making time for our health.'}</text>
 <text x="90" y="1440" font-size="48" font-weight="bold">THE WIN: SHOWING UP.</text>
 <text x="90" y="1545" font-size="29">${solo?'My pace. My progress.':'A shared intention. No medical rankings.'}</text>
 <text x="90" y="1600" font-size="29">Choose a habit. Encourage each other.</text>
 <text x="90" y="1750" font-size="36" fill="#fdba74">#RelivTogether · @reliv_care</text>
 </g></svg>`;
 return sharp(Buffer.from(svg)).composite([{input:logo,left:90,top:110}]).png().toBuffer();
}
