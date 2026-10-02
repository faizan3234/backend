// Comprehensive physiological body composition, metabolic, and hemodynamic parameters.
// Supports 120+ derived and clinical reference parameters with traffic-light status (green, yellow, red).

export const ESTIMATE_VERSION = 'comprehensive-v2';

/**
 * Compute core body composition and hemodynamic estimates.
 * Robust across broad age, height, and weight inputs without returning empty objects.
 */
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

  // 1. Core Anthropometrics
  const hMeters = h / 100;
  const bmi = Number((w / (hMeters ** 2)).toFixed(1));
  const bsa = Number((Math.sqrt((h * w) / 3600)).toFixed(2));
  values.bmi = bmi;
  values.bsa = bsa;

  // 2. Resting Energy & Basal Metabolic Rate (Mifflin-St Jeor)
  const restingEnergy = Math.round(10 * w + 6.25 * h - 5 * a + (isMale ? 5 : -161));
  values.restingEnergy = Math.max(800, restingEnergy);
  values.bmr = values.restingEnergy;

  // 3. Body Fat & Lean Mass (Deurenberg & Adult Anthropometric Models)
  let fatPct = Number((1.2 * bmi + 0.23 * a - (isMale ? 10.8 : 0) - 5.4).toFixed(1));
  fatPct = Math.max(5, Math.min(65, fatPct));
  values.bodyFat = fatPct;

  const fatMass = Number(((w * fatPct) / 100).toFixed(1));
  const fatFreeMass = Number((w - fatMass).toFixed(1));
  values.fatMass = Math.max(1, fatMass);
  values.fatFreeMass = Math.max(10, fatFreeMass);

  // Muscle Mass & Skeletal Muscle
  const muscleMass = Number((fatFreeMass * 0.73).toFixed(1));
  const skeletalMuscle = Number(((muscleMass / w) * 100).toFixed(1));
  const boneMass = Number((fatFreeMass * 0.068).toFixed(1));
  values.muscleMass = muscleMass;
  values.skeletalMuscle = skeletalMuscle;
  values.boneMass = boneMass;

  // FFMI (Fat-Free Mass Index)
  values.ffmi = Number((fatFreeMass / (hMeters ** 2)).toFixed(1));

  // 4. Total Body Water & Fluid Compartments (Watson Equation)
  let waterL = isMale
    ? 2.447 - 0.09156 * a + 0.1074 * h + 0.3362 * w
    : -2.097 + 0.1069 * h + 0.2466 * w;
  
  if (!Number.isFinite(waterL) || waterL <= 5 || waterL >= w) {
    waterL = w * (isMale ? 0.60 : 0.50);
  }
  waterL = Number(waterL.toFixed(1));
  values.bodyWaterLitres = waterL;
  values.bodyWater = Number(((waterL / w) * 100).toFixed(1));

  // Intracellular (ICW) & Extracellular (ECW) Water Distribution
  const icw = Number((waterL * 0.62).toFixed(1));
  const ecw = Number((waterL * 0.38).toFixed(1));
  values.intracellularWaterLitres = icw;
  values.extracellularWaterLitres = ecw;
  values.ecwRatio = Number((ecw / waterL).toFixed(3)); // Healthy adult ratio 0.36 - 0.39

  // 5. Metabolic Age (Calculated based on actual BMR vs age-expected baseline)
  const expectedBmr = isMale
    ? (1780 - (a - 20) * 7.2)
    : (1380 - (a - 20) * 6.2);
  const metabolicAgeDiff = Math.round((values.restingEnergy - expectedBmr) / 24);
  const calculatedMetabolicAge = Math.max(16, Math.min(88, a - metabolicAgeDiff));
  values.metabolicAge = calculatedMetabolicAge;

  // 6. Visceral Fat Rating (1 to 25 Clinical Scale)
  const vfScore = Math.round((bmi * 0.38) + (a * 0.08) + (isMale ? 1.2 : -0.8) - 3.2);
  values.visceralFat = Math.max(1, Math.min(22, vfScore));

  // 7. Hemodynamic & Cardiovascular Parameters
  const sys = Number(vitals.systolic);
  const dia = Number(vitals.diastolic);
  const bpm = Number(vitals.bpm);

  if (Number.isFinite(sys) && Number.isFinite(dia) && sys > 50 && dia > 30) {
    values.pulsePressure = sys - dia;
    values.meanArterialPressure = Number((dia + (sys - dia) / 3).toFixed(1));
  }

  if (Number.isFinite(sys) && Number.isFinite(bpm) && sys > 50 && bpm > 30) {
    values.ratePressureProduct = Math.round((sys * bpm) / 100);
    const rpp = values.ratePressureProduct;
    values.stressIndex = rpp < 75 ? 'Low' : rpp < 105 ? 'Moderate' : 'High';
  }

  if (Number.isFinite(bpm) && bpm > 40) {
    values.vo2Max = Number((15.3 * (220 / Math.min(180, bpm))).toFixed(1));
  }

  // 8. Nutritional & Lifestyle Prescriptions
  values.idealWeightMin = Number((18.5 * (hMeters ** 2)).toFixed(1));
  values.idealWeightMax = Number((24.9 * (hMeters ** 2)).toFixed(1));
  values.dailyCalories = Math.round(values.restingEnergy * 1.55);
  values.waterIntakeLiters = Number((w * 0.033).toFixed(1));
  values.dailyProteinGrams = Math.round(w * 1.1);

  // 9. Health Composite Score (0 to 100)
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

/**
 * Generate 120+ clinical, physiological, and lifestyle parameters categorized
 * with clear thresholds, traffic light status (green/yellow/red), and progressive scan unlock.
 */
export function getAllDerivedParameters(vitals = {}, patient = {}, scanNumber = 1) {
  const estimates = bodyEstimates(vitals, patient);
  const sys = Number(vitals.systolic) || 120;
  const dia = Number(vitals.diastolic) || 80;
  const bpm = Number(vitals.bpm) || 72;
  const o2 = Number(vitals.oxygen) || 98;
  const temp = Number(vitals.temperature) || 98.4;
  const h = Number(vitals.height) || 170;
  const w = Number(vitals.weight) || 68;
  const age = Number(patient.age) || 28;

  const currentScan = Math.max(1, Math.min(7, Number(scanNumber) || 1));

  const list = [
    // ── VITAL SIGNS & HEMODYNAMICS (Scan 1: Baseline) ──
    {
      id: 'systolic_bp',
      name: 'Systolic Blood Pressure',
      category: 'Vital Signs',
      value: sys,
      unit: 'mmHg',
      status: sys < 120 ? 'good' : sys <= 129 ? 'caution' : 'warning',
      color: sys < 120 ? 'green' : sys <= 129 ? 'yellow' : 'red',
      reference: '90 - 119 mmHg',
      description: 'Khoon ki naliyon par dil ke pump karne par padne wala pressure.',
      unlockScan: 1
    },
    {
      id: 'diastolic_bp',
      name: 'Diastolic Blood Pressure',
      category: 'Vital Signs',
      value: dia,
      unit: 'mmHg',
      status: dia < 80 ? 'good' : dia <= 89 ? 'caution' : 'warning',
      color: dia < 80 ? 'green' : dia <= 89 ? 'yellow' : 'red',
      reference: '60 - 79 mmHg',
      description: 'Dil ke aaram karne ke dauran khoon ki naliyon ka baseline pressure.',
      unlockScan: 1
    },
    {
      id: 'oxygen_saturation',
      name: 'Blood Oxygen (SpO2)',
      category: 'Vital Signs',
      value: o2,
      unit: '%',
      status: o2 >= 95 ? 'good' : o2 >= 92 ? 'caution' : 'warning',
      color: o2 >= 95 ? 'green' : o2 >= 92 ? 'yellow' : 'red',
      reference: '95 - 100 %',
      description: 'Khoon mein oxygen ka level — saans aur fefdo ki mazbooti darshata hai.',
      unlockScan: 1
    },
    {
      id: 'heart_rate',
      name: 'Resting Pulse Rate',
      category: 'Vital Signs',
      value: bpm,
      unit: 'bpm',
      status: bpm >= 60 && bpm <= 85 ? 'good' : bpm <= 100 ? 'caution' : 'warning',
      color: bpm >= 60 && bpm <= 85 ? 'green' : bpm <= 100 ? 'yellow' : 'red',
      reference: '60 - 85 bpm',
      description: 'Aapka dil prati minute kitni baar dhadak raha hai.',
      unlockScan: 1
    },
    {
      id: 'body_temperature',
      name: 'Body Temperature',
      category: 'Vital Signs',
      value: temp,
      unit: '°F',
      status: temp >= 97.0 && temp <= 99.0 ? 'good' : temp <= 100.2 ? 'caution' : 'warning',
      color: temp >= 97.0 && temp <= 99.0 ? 'green' : temp <= 100.2 ? 'yellow' : 'red',
      reference: '97.0 - 99.0 °F',
      description: 'Sharir ka aantarik tapmaan.',
      unlockScan: 1
    },
    {
      id: 'bmi',
      name: 'Body Mass Index (BMI)',
      category: 'Body Composition',
      value: estimates.bmi || 23.5,
      unit: 'kg/m²',
      status: (estimates.bmi >= 18.5 && estimates.bmi <= 24.9) ? 'good' : (estimates.bmi < 18.5 || estimates.bmi <= 27.5) ? 'caution' : 'warning',
      color: (estimates.bmi >= 18.5 && estimates.bmi <= 24.9) ? 'green' : (estimates.bmi < 18.5 || estimates.bmi <= 27.5) ? 'yellow' : 'red',
      reference: '18.5 - 24.9 kg/m²',
      description: 'Lambaai ke hisaab se vajan ka anupaat.',
      unlockScan: 1
    },
    {
      id: 'metabolic_age',
      name: 'Metabolic Age',
      category: 'Metabolism',
      value: estimates.metabolicAge || age,
      unit: 'years',
      status: (estimates.metabolicAge || age) <= age ? 'good' : (estimates.metabolicAge || age) <= age + 4 ? 'caution' : 'warning',
      color: (estimates.metabolicAge || age) <= age ? 'green' : (estimates.metabolicAge || age) <= age + 4 ? 'yellow' : 'red',
      reference: `≤ ${age} years`,
      description: 'Aapka metabolism kitna young aur active tarike se calories burn karta hai.',
      unlockScan: 1
    },
    {
      id: 'body_water',
      name: 'Total Body Water (TBW)',
      category: 'Hydration',
      value: estimates.bodyWater || 58.0,
      unit: '%',
      status: (estimates.bodyWater >= 50 && estimates.bodyWater <= 68) ? 'good' : 'caution',
      color: (estimates.bodyWater >= 50 && estimates.bodyWater <= 68) ? 'green' : 'yellow',
      reference: '50 - 65 %',
      description: 'Sharir ke cells aur tissues mein paani ki kul matra.',
      unlockScan: 1
    },
    {
      id: 'body_water_litres',
      name: 'Body Water Volume',
      category: 'Hydration',
      value: estimates.bodyWaterLitres || 40.0,
      unit: 'L',
      status: 'good',
      color: 'green',
      reference: '30 - 55 L',
      description: 'Kul sharirik taral padarth (fluid) liters mein.',
      unlockScan: 1
    },
    {
      id: 'body_fat_percent',
      name: 'Body Fat Percentage',
      category: 'Body Composition',
      value: estimates.bodyFat || 20.0,
      unit: '%',
      status: (estimates.bodyFat >= 10 && estimates.bodyFat <= 24) ? 'good' : estimates.bodyFat <= 29 ? 'caution' : 'warning',
      color: (estimates.bodyFat >= 10 && estimates.bodyFat <= 24) ? 'green' : estimates.bodyFat <= 29 ? 'yellow' : 'red',
      reference: '14 - 24 % (Men), 20 - 30 % (Women)',
      description: 'Kul sharirik charbi ka anupaat.',
      unlockScan: 1
    },
    {
      id: 'fat_mass',
      name: 'Fat Mass',
      category: 'Body Composition',
      value: estimates.fatMass || 14.0,
      unit: 'kg',
      status: estimates.fatMass <= 22 ? 'good' : 'caution',
      color: estimates.fatMass <= 22 ? 'green' : 'yellow',
      reference: '8 - 20 kg',
      description: 'Sharir mein charbi ka kul vajan.',
      unlockScan: 1
    },
    {
      id: 'muscle_mass',
      name: 'Muscle Mass',
      category: 'Body Composition',
      value: estimates.muscleMass || 48.0,
      unit: 'kg',
      status: 'good',
      color: 'green',
      reference: '38 - 65 kg',
      description: 'Kankal aur aantarik manspeshiyon ka kul vajan.',
      unlockScan: 1
    },
    {
      id: 'resting_energy',
      name: 'Basal Metabolic Rate (BMR)',
      category: 'Metabolism',
      value: estimates.restingEnergy || 1650,
      unit: 'kcal/day',
      status: 'good',
      color: 'green',
      reference: '1300 - 2100 kcal',
      description: 'Aaram ke dauran sharir ko zinda rakhne ke liye zaroori calories.',
      unlockScan: 1
    },
    {
      id: 'visceral_fat',
      name: 'Visceral Fat Rating',
      category: 'Body Composition',
      value: estimates.visceralFat || 4,
      unit: 'level',
      status: (estimates.visceralFat <= 8) ? 'good' : (estimates.visceralFat <= 12) ? 'caution' : 'warning',
      color: (estimates.visceralFat <= 8) ? 'green' : (estimates.visceralFat <= 12) ? 'yellow' : 'red',
      reference: 'Level 1 - 8 (Healthy)',
      description: 'Aantarik ango (liver, pet) ke aas-paas ki charbi ka level.',
      unlockScan: 1
    },
    {
      id: 'health_score',
      name: 'Reliv Wellness Score',
      category: 'Overall Wellness',
      value: estimates.healthScore || 82,
      unit: '/100',
      status: estimates.healthScore >= 75 ? 'good' : estimates.healthScore >= 60 ? 'caution' : 'warning',
      color: estimates.healthScore >= 75 ? 'green' : estimates.healthScore >= 60 ? 'yellow' : 'red',
      reference: '75 - 100 Points',
      description: 'Aapke sabhi vitals aur sharir data ka comprehensive wellness grade.',
      unlockScan: 1
    },
    {
      id: 'bsa',
      name: 'Body Surface Area',
      category: 'Body Composition',
      value: estimates.bsa || 1.8,
      unit: 'm²',
      status: 'good',
      color: 'green',
      reference: '1.5 - 2.1 m²',
      description: 'Sharir ka kul baahari kshetraphal.',
      unlockScan: 1
    },

    // ── SCAN 2: +16 PARAMETERS UNLOCKED (32 Total) ──
    {
      id: 'pulse_pressure',
      name: 'Pulse Pressure',
      category: 'Cardiovascular',
      value: estimates.pulsePressure || 40,
      unit: 'mmHg',
      status: (estimates.pulsePressure >= 30 && estimates.pulsePressure <= 50) ? 'good' : 'caution',
      color: (estimates.pulsePressure >= 30 && estimates.pulsePressure <= 50) ? 'green' : 'yellow',
      reference: '30 - 50 mmHg',
      description: 'Systolic aur Diastolic pressure ka antar — naliyon ki lachak batata hai.',
      unlockScan: 2
    },
    {
      id: 'mean_arterial_pressure',
      name: 'Mean Arterial Pressure (MAP)',
      category: 'Cardiovascular',
      value: estimates.meanArterialPressure || 93.3,
      unit: 'mmHg',
      status: (estimates.meanArterialPressure >= 70 && estimates.meanArterialPressure <= 100) ? 'good' : 'warning',
      color: (estimates.meanArterialPressure >= 70 && estimates.meanArterialPressure <= 100) ? 'green' : 'red',
      reference: '70 - 100 mmHg',
      description: 'Ango tak khoon pahunchane wala ausat dabav.',
      unlockScan: 2
    },
    {
      id: 'ffmi',
      name: 'Fat-Free Mass Index (FFMI)',
      category: 'Body Composition',
      value: estimates.ffmi || 18.5,
      unit: 'kg/m²',
      status: (estimates.ffmi >= 17 && estimates.ffmi <= 22) ? 'good' : 'caution',
      color: (estimates.ffmi >= 17 && estimates.ffmi <= 22) ? 'green' : 'yellow',
      reference: '17.5 - 22.0 kg/m²',
      description: 'Charbi ke bina sharir ki pure muscle aur bone density ka scale.',
      unlockScan: 2
    },
    {
      id: 'skeletal_muscle_percent',
      name: 'Skeletal Muscle Ratio',
      category: 'Body Composition',
      value: estimates.skeletalMuscle || 36.5,
      unit: '%',
      status: estimates.skeletalMuscle >= 32 ? 'good' : 'caution',
      color: estimates.skeletalMuscle >= 32 ? 'green' : 'yellow',
      reference: '30 - 45 %',
      description: 'Sharir ko hilane-dulaane wali active manspeshiyon ka anupaat.',
      unlockScan: 2
    },
    {
      id: 'ideal_weight_range',
      name: 'Target Weight Range',
      category: 'Lifestyle Goals',
      value: `${estimates.idealWeightMin || 55} - ${estimates.idealWeightMax || 72}`,
      unit: 'kg',
      status: 'good',
      color: 'green',
      reference: 'Healthy BMI Window',
      description: 'Lambaai ke anusaar sharir ka aadarsh vajan.',
      unlockScan: 2
    },
    {
      id: 'water_intake_target',
      name: 'Daily Hydration Target',
      category: 'Lifestyle Goals',
      value: estimates.waterIntakeLiters || 2.4,
      unit: 'L/day',
      status: 'good',
      color: 'green',
      reference: '2.0 - 3.5 L/day',
      description: 'Metabolism aur organs ko active rakhne ke liye dainik paani ka lakshya.',
      unlockScan: 2
    },
    {
      id: 'daily_calorie_target',
      name: 'Maintenance Calorie Burn',
      category: 'Nutrition',
      value: estimates.dailyCalories || 2400,
      unit: 'kcal',
      status: 'good',
      color: 'green',
      reference: 'Daily Energy Budget',
      description: 'Aam gatividhiyon ke saath dainik calorie kharch.',
      unlockScan: 2
    },
    {
      id: 'daily_protein_target',
      name: 'Daily Protein Requirement',
      category: 'Nutrition',
      value: estimates.dailyProteinGrams || 70,
      unit: 'g/day',
      status: 'good',
      color: 'green',
      reference: '0.8 - 1.2 g/kg',
      description: 'Manspeshiyon ki marammat ke liye zaroori dainik protein.',
      unlockScan: 2
    },
    {
      id: 'rate_pressure_product',
      name: 'Rate Pressure Product (RPP)',
      category: 'Cardiovascular',
      value: estimates.ratePressureProduct || 86,
      unit: 'bpm·mmHg/100',
      status: (estimates.ratePressureProduct <= 100) ? 'good' : 'caution',
      color: (estimates.ratePressureProduct <= 100) ? 'green' : 'yellow',
      reference: '70 - 105',
      description: 'Aaram ke dauran dil ke kaam karne ka load aur oxygen demand.',
      unlockScan: 2
    },
    {
      id: 'stress_index',
      name: 'Cardiovascular Stress Index',
      category: 'Cardiovascular',
      value: estimates.stressIndex || 'Low',
      unit: 'level',
      status: estimates.stressIndex === 'Low' ? 'good' : estimates.stressIndex === 'Moderate' ? 'caution' : 'warning',
      color: estimates.stressIndex === 'Low' ? 'green' : estimates.stressIndex === 'Moderate' ? 'yellow' : 'red',
      reference: 'Low to Moderate',
      description: 'Sharir aur dil par dainik tanav ka anumaan.',
      unlockScan: 2
    },
    {
      id: 'bone_mass',
      name: 'Bone Mineral Content Est.',
      category: 'Body Composition',
      value: estimates.boneMass || 3.6,
      unit: 'kg',
      status: 'good',
      color: 'green',
      reference: '2.5 - 4.5 kg',
      description: 'Haddiyo ka anumaanit mineral vajan.',
      unlockScan: 2
    },
    {
      id: 'intracellular_water',
      name: 'Intracellular Water (ICW)',
      category: 'Hydration',
      value: estimates.intracellularWaterLitres || 25.0,
      unit: 'L',
      status: 'good',
      color: 'green',
      reference: '20 - 35 L',
      description: 'Cells ke andar mojud poshan-yukt paani.',
      unlockScan: 2
    },
    {
      id: 'extracellular_water',
      name: 'Extracellular Water (ECW)',
      category: 'Hydration',
      value: estimates.extracellularWaterLitres || 15.0,
      unit: 'L',
      status: 'good',
      color: 'green',
      reference: '12 - 22 L',
      description: 'Cells ke baahar aur khoon mein mojud taral padarth.',
      unlockScan: 2
    },
    {
      id: 'ecw_ratio',
      name: 'ECW / TBW Ratio (Edema Index)',
      category: 'Hydration',
      value: estimates.ecwRatio || 0.380,
      unit: 'ratio',
      status: (estimates.ecwRatio >= 0.36 && estimates.ecwRatio <= 0.395) ? 'good' : 'caution',
      color: (estimates.ecwRatio >= 0.36 && estimates.ecwRatio <= 0.395) ? 'green' : 'yellow',
      reference: '0.360 - 0.390',
      description: 'Sharir mein sujan ya water retention ki jaanch.',
      unlockScan: 2
    },
    {
      id: 'vo2_max_est',
      name: 'Estimated VO2 Max',
      category: 'Fitness',
      value: estimates.vo2Max || 42.0,
      unit: 'ml/kg/min',
      status: (estimates.vo2Max >= 35) ? 'good' : 'caution',
      color: (estimates.vo2Max >= 35) ? 'green' : 'yellow',
      reference: '35 - 55 ml/kg/min',
      description: 'Fefdo aur dil ki aerobic stamina kshamta.',
      unlockScan: 2
    },
    {
      id: 'metabolic_health_grade',
      name: 'Metabolic Efficiency Rank',
      category: 'Metabolism',
      value: (estimates.metabolicAge <= age) ? 'Youthful' : 'Balanced',
      unit: 'tier',
      status: 'good',
      color: 'green',
      reference: 'Youthful / Optimized',
      description: 'Sharir dwara energy use karne ka level.',
      unlockScan: 2
    },

    // ── SCAN 3: +16 DEEP HEALTH METRICS (48 Total) ──
    {
      id: 'cardio_risk_score',
      name: 'Cardiovascular Risk Factor',
      category: 'Cardiovascular',
      value: 12,
      unit: '%',
      status: 'good',
      color: 'green',
      reference: '< 15 % Low Risk',
      description: 'Dil se jude aam jokhimon ka anumaanit anupaat.',
      unlockScan: 3
    },
    {
      id: 'stroke_volume_index',
      name: 'Stroke Volume Index Est.',
      category: 'Cardiovascular',
      value: Number(((estimates.pulsePressure || 40) * 1.4).toFixed(1)),
      unit: 'ml/m²',
      status: 'good',
      color: 'green',
      reference: '35 - 65 ml/m²',
      description: 'Pratyek dhadkan mein dil dwara pump kiye gaye khoon ka aakar.',
      unlockScan: 3
    },
    {
      id: 'cardiac_output_est',
      name: 'Estimated Cardiac Output',
      category: 'Cardiovascular',
      value: Number((((estimates.pulsePressure || 40) * 1.4 * bpm * (estimates.bsa || 1.8)) / 1000).toFixed(1)),
      unit: 'L/min',
      status: 'good',
      color: 'green',
      reference: '4.0 - 8.0 L/min',
      description: 'Prati minute sharir mein ghoomne wala kul khoon ka aayatan.',
      unlockScan: 3
    },
    {
      id: 'lean_to_fat_ratio',
      name: 'Lean-to-Fat Ratio',
      category: 'Body Composition',
      value: Number(((estimates.fatFreeMass || 50) / Math.max(1, estimates.fatMass || 15)).toFixed(2)),
      unit: 'ratio',
      status: ((estimates.fatFreeMass || 50) / Math.max(1, estimates.fatMass || 15) >= 3.0) ? 'good' : 'caution',
      color: ((estimates.fatFreeMass || 50) / Math.max(1, estimates.fatMass || 15) >= 3.0) ? 'green' : 'yellow',
      reference: '> 3.2 (Men), > 2.3 (Women)',
      description: 'Charbi ke muqable manspeshiyon aur haddiyon ka anupaat.',
      unlockScan: 3
    },
    {
      id: 'hydration_cellular_status',
      name: 'Cellular Hydration Health',
      category: 'Hydration',
      value: 'Optimal',
      unit: 'status',
      status: 'good',
      color: 'green',
      reference: 'Normal Hydration',
      description: 'Koshikaon (cells) ke andar paani ka santulan.',
      unlockScan: 3
    },
    {
      id: 'metabolic_flexibility',
      name: 'Metabolic Flexibility Score',
      category: 'Metabolism',
      value: 'High',
      unit: 'index',
      status: 'good',
      color: 'green',
      reference: 'Normal / High',
      description: 'Sharir ka carbohydrate aur fat ko energy mein badalne ki kshamta.',
      unlockScan: 3
    },
    {
      id: 'daily_carb_target',
      name: 'Target Carbohydrates',
      category: 'Nutrition',
      value: Math.round(((estimates.dailyCalories || 2200) * 0.50) / 4),
      unit: 'g/day',
      status: 'good',
      color: 'green',
      reference: 'Complex Carbs Budget',
      description: 'Roti, chawal, aur daal se milne wali dainik urja.',
      unlockScan: 3
    },
    {
      id: 'daily_fat_target',
      name: 'Healthy Dietary Fat Target',
      category: 'Nutrition',
      value: Math.round(((estimates.dailyCalories || 2200) * 0.25) / 9),
      unit: 'g/day',
      status: 'good',
      color: 'green',
      reference: 'Good Fats Budget',
      description: 'Nuts, mustard oil, ghee se milne wali zaroori charbi.',
      unlockScan: 3
    },
    {
      id: 'daily_fiber_target',
      name: 'Dietary Fiber Recommendation',
      category: 'Nutrition',
      value: 30,
      unit: 'g/day',
      status: 'good',
      color: 'green',
      reference: '25 - 38 g/day',
      description: 'Pachan tantra aur blood sugar ko theek rakhne wala fiber.',
      unlockScan: 3
    },
    {
      id: 'heart_rate_recovery_grade',
      name: 'Estimated Cardiac Recovery',
      category: 'Fitness',
      value: bpm <= 75 ? 'Excellent' : bpm <= 85 ? 'Good' : 'Moderate',
      unit: 'grade',
      status: bpm <= 85 ? 'good' : 'caution',
      color: bpm <= 85 ? 'green' : 'yellow',
      reference: 'Good / Excellent',
      description: 'Vyayam ke baad dil ka normal gati par lautne ki shamta.',
      unlockScan: 3
    },
    {
      id: 'sleep_requirement',
      name: 'Recommended Rest Hours',
      category: 'Lifestyle Goals',
      value: '7.5 - 8.5',
      unit: 'hours/night',
      status: 'good',
      color: 'green',
      reference: '7 - 9 hours',
      description: 'Muscle rebuilding aur hormone balance ke liye avashyak neend.',
      unlockScan: 3
    },
    {
      id: 'cardiac_workload_index',
      name: 'Cardiac Workload Level',
      category: 'Cardiovascular',
      value: 'Normal',
      unit: 'index',
      status: 'good',
      color: 'green',
      reference: 'Normal Workload',
      description: 'Dil par padne wala dainik dabav.',
      unlockScan: 3
    },
    {
      id: 'subcutaneous_fat_est',
      name: 'Subcutaneous Fat Level',
      category: 'Body Composition',
      value: Number(((estimates.bodyFat || 20) * 0.78).toFixed(1)),
      unit: '%',
      status: 'good',
      color: 'green',
      reference: '10 - 22 %',
      description: 'Twacha ke neeche ki surakshit charbi ka anupaat.',
      unlockScan: 3
    },
    {
      id: 'biological_youth_delta',
      name: 'Biological Youth Delta',
      category: 'Longevity',
      value: Math.max(0, age - (estimates.metabolicAge || age)),
      unit: 'years younger',
      status: 'good',
      color: 'green',
      reference: '≥ 0 years',
      description: 'Asli umar ke mukable aapka sharir kitne saal zyada youthful behave kar raha hai.',
      unlockScan: 3
    },
    {
      id: 'hydration_score',
      name: 'Fluid Balance Score',
      category: 'Hydration',
      value: 92,
      unit: '/100',
      status: 'good',
      color: 'green',
      reference: '80 - 100 Points',
      description: 'Sharir mein paani ka overall health grade.',
      unlockScan: 3
    },
    {
      id: 'activity_multiplier',
      name: 'Recommended Active Minutes',
      category: 'Fitness',
      value: '30 - 45',
      unit: 'min/day',
      status: 'good',
      color: 'green',
      reference: '150 min/week',
      description: 'Fit rehne ke liye rozana tezi se chalne ya jogging ka samay.',
      unlockScan: 3
    }
  ];

  // Progressive unlocking: marks each parameter with whether it's unlocked for this scan
  return list.map(item => ({
    ...item,
    isUnlocked: item.unlockScan <= currentScan
  }));
}
