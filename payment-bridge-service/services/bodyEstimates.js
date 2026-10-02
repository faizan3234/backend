// Adult population estimates, never legacy impedance heuristics.
// Sources and applicability: docs/REPORT_INSIGHTS.md. Never clamp to a healthy result.
export const ESTIMATE_VERSION = 'anthropometry-v1';
export function bodyEstimates(vitals = {}, patient = {}) {
  const h = Number(vitals.height), w = Number(vitals.weight), a = Number(patient.age);
  const gender = String(patient.gender || '').toLowerCase(), values = {};
  if (!(h >= 100 && h <= 230 && w >= 20 && w <= 300 && a >= 20 && a <= 78)) return values;
  const bmi = w / ((h / 100) ** 2);
  values.bmi = bmi; values.bsa = Math.sqrt(h * w / 3600);
  if (['male', 'female'].includes(gender)) {
    const male = gender === 'male';
    values.restingEnergy = 10*w + 6.25*h - 5*a + (male ? 5 : -161);
    const fat = 1.2*bmi + 0.23*a - (male ? 10.8 : 0) - 5.4;
    if (fat > 0 && fat < 70) {
      values.bodyFat = fat; values.fatMass = w*fat/100;
      values.fatFreeMass = w-values.fatMass; values.ffmi = values.fatFreeMass / ((h/100)**2);
    }
    const water = male ? 2.447 - 0.09156*a + 0.1074*h + 0.3362*w : -2.097 + 0.1069*h + 0.2466*w;
    if (water > 0 && water < w) { values.bodyWaterLitres = water; values.bodyWater = water/w*100; }
  }
  return Object.fromEntries(Object.entries(values).filter(([,v])=>Number.isFinite(v)&&v>0).map(([k,v])=>[k,Number(v.toFixed(k==='bsa'?2:k==='restingEnergy'?0:1))]));
}
