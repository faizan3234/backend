// Match the kiosk's displayed body-score estimate using the signed snapshot.
// This is not a clinically validated health rating and is never a payment input.
export function storySummary(snapshot) {
 const v=snapshot?.vitals||{},p=snapshot?.patient||{};
 const base={name:typeof p.name==='string'?p.name.trim().slice(0,80):'',win:todayWin(snapshot),focus:reportFocus(snapshot),scanNumber:Number.isSafeInteger(snapshot?.scanNumber)&&snapshot.scanNumber>0?snapshot.scanNumber:1};
 const weight=Number(v.weight),height=Number(v.height),age=Number(p.age);
 const gender=String(p.gender||'').toLowerCase();
 if(!([weight,height,age].every(n=>Number.isFinite(n)&&n>0))||!['male','female'].includes(gender))return {...base,score:null};
 const male=gender==='male',z=Number(v.impedance)||0;
 const round=n=>Math.round(n*1e5)/1e5;
 const bmi=Math.max(1,Math.min(round(weight/(height/100)**2),90));
 let ffm=z>0?(male ? .85*height**2/z+.18*weight-.1*age-1.5:.55*height**2/z+.15*weight+11):weight*(male ? .82:.72);
 if(z>0)ffm=Math.max(weight*.4,Math.min(ffm,weight*.95));
 const fat=Math.max(male?4:10,Math.min(round(Math.max(0,weight-ffm)/weight*100),male?45:50));
 const score=Math.max(0,Math.min(100,Math.round(100-Math.abs(bmi-22)*1.2-Math.abs(fat-(male?12:22))*1.5)));
 return {...base,score};
}

// A positive observed highlight, not an overall all-clear or a ranking of organs.
// Never infer hydration from a body-water formula or invent a healthy result.
export function todayWin(snapshot) {
 const v=snapshot?.vitals||{},age=Number(snapshot?.patient?.age);
 const oxygen=Number(v.oxygen),height=Number(v.height),weight=Number(v.weight);
 if(age>=20&&age<=120&&height>=100&&height<=230&&weight>=20&&weight<=300){
  const bmi=weight/(height/100)**2;
  if(bmi>=18.5&&bmi<25)return 'Healthy BMI';
 }
 if(Number.isFinite(oxygen)&&oxygen>=95&&oxygen<=100)return 'Good oxygen level';
 return 'Completed my check-in';
}

// A report-reading prompt, not a diagnosis or a prescription from a share card.
export function reportFocus(snapshot) {
 const v=snapshot?.vitals||{};
 const present=key=>v[key]!==null&&v[key]!==undefined&&v[key]!==''&&Number.isFinite(Number(v[key]))&&Number(v[key])>0;
 if(present('systolic')&&present('diastolic'))return 'Understand my blood pressure and its next steps';
 if(present('oxygen'))return 'Review my oxygen reading and its guidance';
 if(present('weight')&&present('height'))return 'Review my weight guidance and choose one next step';
 return 'Review my report and choose one next step';
}
