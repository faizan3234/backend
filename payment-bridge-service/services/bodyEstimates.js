// Comprehensive adult physiological body composition, metabolic, and hemodynamic estimates.
// Computes BMR, metabolic age, body water, visceral fat, muscle mass, and full metrics without arbitrary omissions.

export const ESTIMATE_VERSION = 'comprehensive-v2';

export function bodyEstimates(vitals = {}, patient = {}) {
  const rawH = vitals.height ?? patient.height;
  const rawW = vitals.weight ?? patient.weight;
  const rawA = patient.age ?? vitals.age ?? 28;

  const h = Number(rawH);
  const w = Number(rawW);
  const a = Math.max(12, Math.min(100, Number(rawA) || 28));
  const gender = String(patient.gender || vitals.gender || 'male').toLowerCase();
  const isMale = gender !== 'female';

  const values = {};
  if (!Number.isFinite(h) || !Number.isFinite(w) || h < 70 || h > 250 || w < 15 || w > 350) {
    return values;
  }

  // 1. BMI & BSA
  const hMeters = h / 100;
  const bmi = Number((w / (hMeters ** 2)).toFixed(1));
  const bsa = Number((Math.sqrt((h * w) / 3600)).toFixed(2));
  values.bmi = bmi;
  values.bsa = bsa;

  // 2. Resting Energy & BMR (Mifflin-St Jeor)
  const restingEnergy = Math.round(10 * w + 6.25 * h - 5 * a + (isMale ? 5 : -161));
  values.restingEnergy = Math.max(800, restingEnergy);
  values.bmr = values.restingEnergy;

  // 3. Body Fat & Lean Mass Breakdown
  let fatPct = Number((1.2 * bmi + 0.23 * a - (isMale ? 10.8 : 0) - 5.4).toFixed(1));
  fatPct = Math.max(5, Math.min(65, fatPct));
  values.bodyFat = fatPct;

  const fatMass = Number(((w * fatPct) / 100).toFixed(1));
  const fatFreeMass = Number((w - fatMass).toFixed(1));
  values.fatMass = Math.max(1, fatMass);
  values.fatFreeMass = Math.max(10, fatFreeMass);

  // Muscle & Bone
  const muscleMass = Number((fatFreeMass * 0.73).toFixed(1));
  const skeletalMuscle = Number(((muscleMass / w) * 100).toFixed(1));
  const boneMass = Number((fatFreeMass * 0.068).toFixed(1));
  values.muscleMass = muscleMass;
  values.skeletalMuscle = skeletalMuscle;
  values.boneMass = boneMass;
  values.ffmi = Number((fatFreeMass / (hMeters ** 2)).toFixed(1));

  // 4. Body Water Compartments (Watson Equation)
  let waterL = isMale
    ? 2.447 - 0.09156 * a + 0.1074 * h + 0.3362 * w
    : -2.097 + 0.1069 * h + 0.2466 * w;
  if (!Number.isFinite(waterL) || waterL <= 5 || waterL >= w) {
    waterL = w * (isMale ? 0.60 : 0.50);
  }
  waterL = Number(waterL.toFixed(1));
  values.bodyWaterLitres = waterL;
  values.bodyWater = Number(((waterL / w) * 100).toFixed(1));

  // Intracellular / Extracellular Water
  values.intracellularWaterLitres = Number((waterL * 0.62).toFixed(1));
  values.extracellularWaterLitres = Number((waterL * 0.38).toFixed(1));
  values.ecwRatio = Number((values.extracellularWaterLitres / waterL).toFixed(3));

  // 5. Metabolic Age (Calculated relative to expected age-matched BMR)
  const expectedBmr = isMale
    ? (1780 - (a - 20) * 7.2)
    : (1380 - (a - 20) * 6.2);
  const metabolicAgeDiff = Math.round((values.restingEnergy - expectedBmr) / 24);
  values.metabolicAge = Math.max(16, Math.min(88, a - metabolicAgeDiff));

  // 6. Visceral Fat (1 to 25 Scale)
  const vfScore = Math.round((bmi * 0.38) + (a * 0.08) + (isMale ? 1.2 : -0.8) - 3.2);
  values.visceralFat = Math.max(1, Math.min(22, vfScore));

  // 7. Hemodynamic parameters if vitals present
  const sys = Number(vitals.systolic);
  const dia = Number(vitals.diastolic);
  const bpm = Number(vitals.bpm);

  if (Number.isFinite(sys) && Number.isFinite(dia) && sys > 50 && dia > 30) {
    values.pulsePressure = sys - dia;
    values.meanArterialPressure = Number((dia + (sys - dia) / 3).toFixed(1));
  }
  if (Number.isFinite(sys) && Number.isFinite(bpm) && sys > 50 && bpm > 30) {
    values.ratePressureProduct = Math.round((sys * bpm) / 100);
    values.stressIndex = values.ratePressureProduct < 75 ? 'Low' : values.ratePressureProduct < 105 ? 'Moderate' : 'High';
  }
  if (Number.isFinite(bpm) && bpm > 40) {
    values.vo2Max = Number((15.3 * (220 / Math.min(180, bpm))).toFixed(1));
  }

  // 8. Lifestyle and Calorie Guidance
  values.idealWeightMin = Number((18.5 * (hMeters ** 2)).toFixed(1));
  values.idealWeightMax = Number((24.9 * (hMeters ** 2)).toFixed(1));
  values.dailyCalories = Math.round(values.restingEnergy * 1.55);
  values.waterIntakeLiters = Number((w * 0.033).toFixed(1));
  values.dailyProteinGrams = Math.round(w * 1.1);

  // 9. Overall Health Grade Score (35-99)
  let healthScore = 75;
  if (bmi >= 18.5 && bmi <= 24.9) healthScore += 8;
  else if (bmi >= 25 && bmi <= 29.9) healthScore -= 4;
  else healthScore -= 10;

  if (sys >= 110 && sys <= 125 && dia >= 70 && dia <= 82) healthScore += 7;
  else if (sys > 140 || dia > 90) healthScore -= 12;

  const o2 = Number(vitals.oxygen);
  if (o2 >= 97) healthScore += 5;
  else if (o2 < 93) healthScore -= 10;

  if (values.metabolicAge <= a) healthScore += 5;
  else healthScore -= 4;

  values.healthScore = Math.max(35, Math.min(99, healthScore));

  return values;
}
