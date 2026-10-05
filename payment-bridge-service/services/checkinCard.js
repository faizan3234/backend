import {storyLayouts,storyFields} from './storyLayout.js';
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
// Both browser preview and email use the original artwork and shared coordinates.
export async function generateCheckinCardPng(value, summary = null) {
 const card=validateStoryCard(value);
 if(!card)throw new Error('Story card required');
 const layout=storyLayouts[card.relationship],fields=storyFields(card,summary);
 const text=Object.entries(layout).map(([key,[x,y,width,size]])=>{
  const content=fields[key];
  const fitted=Math.min(size,width/(Math.max(1,[...content].length)*.65));
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${fitted}" textLength="${Math.min(width,Math.max(1,[...content].length)*fitted*.65)}" lengthAdjust="spacingAndGlyphs" font-weight="bold">${xml(content)}</text>`;
 }).join('');
 const note=card.relationship==='solo'?'':`<text x="${layout.win[0]}" y="${layout.win[1]+24}" text-anchor="middle" font-size="17">${xml(fields.winNote)}</text>`;
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1600"><g font-family="DejaVu Sans, sans-serif" fill="#29291f">${text}${note}</g><text x="450" y="1572" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="14" fill="#29291f">Score is an estimate, not a diagnosis. — = unavailable.</text></svg>`;
 const background=fileURLToPath(new URL(`../assets/story-cards/${card.relationship}.jpeg`,import.meta.url));
 return sharp(background).composite([{input:Buffer.from(svg)}]).png().toBuffer();
}
