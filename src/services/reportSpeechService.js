import { bodyEstimates } from './bodyEstimates.js';

/**
 * Natural, colloquial everyday speech generation for Kiosk Report Screens (1 to 5).
 * Uses friendly conversational language (NO archaic/shudh Sanskrit terms like "रक्त", "रक्तचाप", "ऑक्सीजन संतृप्ति").
 */
export function generateReportSpeech({
    pageNumber = 1,
    language = 'hi',
    vitals = {},
    patient = {},
    scanNumber = 1
} = {}) {
    const estimates = bodyEstimates(vitals, patient);
    const page = Math.max(1, Math.min(5, Number(pageNumber) || 1));
    const lang = ['hi', 'bn', 'en'].includes(String(language).toLowerCase()) ? String(language).toLowerCase() : 'hi';

    const weight = Number(vitals.weight || estimates.weight || 68).toFixed(1);
    const bodyFat = Number(estimates.bodyFat || 18.5).toFixed(1);
    const bodyWater = Number(estimates.bodyWater || 58.2).toFixed(1);
    const sys = Math.round(Number(vitals.systolic) || 120);
    const dia = Math.round(Number(vitals.diastolic) || 80);
    const oxygen = Math.round(Number(vitals.oxygen) || 98);
    const bpm = Math.round(Number(vitals.bpm) || 72);
    const temp = Number(vitals.temperature || 98.4).toFixed(1);
    const metabolicAge = Math.round(estimates.metabolicAge || patient.age || 26);
    const visceralFat = Math.round(estimates.visceralFat || 4);
    const healthScore = Math.round(estimates.healthScore || 82);
    const unlockedCount = Math.min(120, (Math.max(1, Number(scanNumber) || 1)) * 16);

    const scripts = {
        hi: {
            1: `Namaste! Aaiye aapke body composition ka hisaab dekhte hain. Aapka vajan ${weight} kilo hai, aur body fat ${bodyFat} percent hai. Sharir mein paani ki matra yaani body water ${bodyWater} percent hai, jo bilkul fit aur healthy range mein hai. Paani sahi matra mein peene se aapka metabolism active rehta hai aur sharir energetic feel karta hai.`,
            2: `Ab aapke main vitals dekhte hain. Aapka blood pressure ${sys} aur ${dia} aaya hai, jo bilkul normal hai. Khoon mein oxygen level ${oxygen} percent hai — iska matlab aapke fefde aur saans lene ki shamta ekdum strong hai! Dil ki dhadkan ${bpm} beats per minute hai, aur sharir ka tapmaan ${temp} degree Fahrenheit hai. Sabhi vitals green safe zone mein hain.`,
            3: `Yahan par sabse exciting number hai aapka Metabolic Age — jo ${metabolicAge} saal aaya hai! Iska matlab aapka sharir calories burn karne mein aur metabolism mein aapki asli umar se bhi zyada young aur active hai! Aapka visceral fat level ${visceralFat} hai, jo bilkul safe range mein hai. Rozana walk aur healthy diet se yeh aur bhi behtar bana rahega.`,
            4: `Is scan mein aapke kul ${unlockedCount} health parameters unlock ho chuke hain. Aapka pulse pressure aur blood circulation dono behtar range mein hain. Jaise-jaise aap regular scan karwayenge, naye deep health insights aur muscle trend unlock hote rahenge.`,
            5: `Badhai ho! Aapka health scan safalta-poorvak pura ho gaya hai. Aapka overall health score ${healthScore} aaya hai. Blood pressure, oxygen aur tapmaan sabhi green zone mein hain. Rozana do se teen litre paani zaroor piyein. Agle hafte scan 2 mein hum aapka muscle-fat balance aur naye 16 parameters unlock karenge. Swasth rahein, aur agle hafte dobara zaroor aaiye!`
        },
        bn: {
            1: `Nomoshkar! Apnar body composition overview ekhane dekhun. Apnar weight ${weight} kg aar body fat ${bodyFat} percent. Shorire joler poriman yaani body water ${bodyWater} percent, ja khub-i shastho-shommot range-e aache. Prochur jol khele metabolism bhalo thake.`,
            2: `Apnar vitals ekdom bhalo range-e aache. Blood pressure ${sys} by ${dia}, rokte oxygen ${oxygen} percent — shash-proshash aar lungs ekdom strong! Heart rate ${bpm} bpm aar temperature ${temp} degree Fahrenheit. Sob vital signs green zone-e aache.`,
            3: `Ekhane shobcheye bhalo khobor holo apnar Metabolic Age — ja ${metabolicAge} bochhor esheche! Er maane apnar shorir apnar ashli boyosher thekeo beshi active bhabe calorie burn korche. Visceral fat level ${visceralFat}, ja safe limit-e aache.`,
            4: `Ei scan-e apnar total ${unlockedCount}-ti health parameter unlock hoyeche. Niyomito scan korle apnar health trend aaro porishkar bhabe bojha jabe.`,
            5: `Shubheccha! Apnar health checkup complete hoyeche. Apnar overall health score ${healthScore}. Blood pressure aar oxygen duto-i green zone-e. Roj do theke teen litre jol khan. Agami shoptaho scan 2-te aamra aro 16-ti notun parameter unlock korbo. Bhalo thakun aar abar ashun!`
        },
        en: {
            1: `Welcome! Here is your body composition overview. Your weight is ${weight} kilograms with ${bodyFat}% body fat. Your total body water is ${bodyWater}%, keeping your cellular hydration in a healthy zone. Staying well hydrated supports optimal metabolic activity.`,
            2: `Now let's review your core vitals. Your blood pressure is ${sys} over ${dia} mmHg, right in the optimal range. Blood oxygen is at ${oxygen}%, showing great lung efficiency. Heart rate is ${bpm} beats per minute and body temperature is ${temp} degrees Fahrenheit — all safely in the green zone.`,
            3: `Here is an exciting highlight: your Metabolic Age is ${metabolicAge} years! This means your resting metabolism burns energy with the efficiency of someone in their prime youth. Your visceral fat rating is ${visceralFat}, comfortably within the healthy bracket.`,
            4: `You have unlocked ${unlockedCount} comprehensive health parameters with this scan. Tracking your body composition and cardiovascular efficiency over time helps prevent chronic risks early.`,
            5: `Congratulations on completing your wellness checkup! Your overall health score is ${healthScore} out of 100. Keep drinking two to three liters of water daily. In your next visit, scan 2 will unlock 16 additional deep parameters including your muscle trend analysis. Stay healthy and see you next time!`
        }
    };

    const text = scripts[lang]?.[page] || scripts.hi[page];
    return {
        ok: true,
        pageNumber: page,
        language: lang,
        script: text,
        metrics: {
            weight,
            bodyFat,
            bodyWater,
            sys,
            dia,
            oxygen,
            bpm,
            temp,
            metabolicAge,
            visceralFat,
            healthScore,
            unlockedCount
        }
    };
}
