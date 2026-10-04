// Match the kiosk's displayed body-score estimate using the signed snapshot.
// This is not a clinically validated health rating and is never a payment input.
export function storySummary(snapshot) {
 const v=snapshot?.vitals||{},p=snapshot?.patient||{};
 const weight=Number(v.weight),height=Number(v.height),age=Number(p.age);
 const gender=String(p.gender||'').toLowerCase();
 if(!([weight,height,age].every(n=>Number.isFinite(n)&&n>0))||!['male','female'].includes(gender))return {score:null,scanNumber:snapshot?.scanNumber||1};
 const male=gender==='male',z=Number(v.impedance)||0;
 const round=n=>Math.round(n*1e5)/1e5;
 const bmi=Math.max(1,Math.min(round(weight/(height/100)**2),90));
 let ffm=z>0?(male ? .85*height**2/z+.18*weight-.1*age-1.5:.55*height**2/z+.15*weight+11):weight*(male ? .82:.72);
 if(z>0)ffm=Math.max(weight*.4,Math.min(ffm,weight*.95));
 const fat=Math.max(male?4:10,Math.min(round(Math.max(0,weight-ffm)/weight*100),male?45:50));
 const score=Math.max(0,Math.min(100,Math.round(100-Math.abs(bmi-22)*1.2-Math.abs(fat-(male?12:22))*1.5)));
 return {score,scanNumber:Number.isSafeInteger(snapshot.scanNumber)&&snapshot.scanNumber>0?snapshot.scanNumber:1};
}
