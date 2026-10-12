// Narrate supplied report values only. Missing values are not normal readings.
const copy = {
    en: { missing:'not available', intro:['Your body measurements.','Your recorded vital signs.','Your reported body estimates.','Your available report measurements.','Your report summary.'], note:'These figures alone do not establish that you are healthy. Estimates are not direct measurements.', next:'A later scan can be compared with today where the same measurements are available.', labels:['Weight','Body fat','Body water','Blood pressure, upper number','Blood pressure, lower number','Blood oxygen','Pulse','Temperature','Metabolic age estimate','Visceral fat estimate','Health score'], units:['kilograms','percent','percent','','','percent','beats per minute','degrees','years','','out of 100'] },
    hi: { missing:'अभी उपलब्ध नहीं है', intro:['चलिए, आपके शरीर की माप देखते हैं।','ये आपकी रिकॉर्ड की गई रीडिंग हैं।','ये रिपोर्ट में दिए गए शरीर के अनुमान हैं।','रिपोर्ट में जो माप हैं, उन्हें देखते हैं।','अब आपकी रिपोर्ट का सार।'], note:'सिर्फ इन नंबरों से यह नहीं कह सकते कि सब ठीक है। अनुमान और सीधे ली गई माप अलग हैं।', next:'अगली बार यही माप मिले, तो आज से तुलना की जा सकती है।', labels:['वजन','body fat','body water','blood pressure का ऊपर वाला नंबर','blood pressure का नीचे वाला नंबर','oxygen','धड़कन','तापमान','Metabolic Age का अनुमान','visceral fat का अनुमान','हेल्थ स्कोर'],units:['किलो','प्रतिशत','प्रतिशत','','','प्रतिशत','प्रति मिनट','डिग्री','साल','','अंक, कुल 100'] },
    bn: { missing:'এখন পাওয়া যায়নি', intro:['আপনার শরীরের মাপগুলো দেখি।','এগুলো আপনার রেকর্ড করা রিডিং।','এগুলো রিপোর্টে থাকা শরীরের আনুমানিক হিসাব।','রিপোর্টে যে মাপগুলো আছে, সেগুলো দেখি।','এবার আপনার রিপোর্টের সারাংশ।'], note:'শুধু এই সংখ্যাগুলো থেকে সব ঠিক আছে বলা যায় না। আনুমানিক হিসাব আর সরাসরি মাপ এক নয়।', next:'পরের বার একই মাপ পাওয়া গেলে আজকের সঙ্গে তুলনা করা যাবে।', labels:['ওজন','body fat','body water','blood pressure-এর ওপরের সংখ্যা','blood pressure-এর নিচের সংখ্যা','oxygen','হৃদস্পন্দন','তাপমাত্রা','Metabolic Age-এর আনুমানিক হিসাব','visceral fat-এর আনুমানিক হিসাব','হেলথ স্কোর'],units:['কিলো','শতাংশ','শতাংশ','','','শতাংশ','প্রতি মিনিট','ডিগ্রি','বছর','','১০০-এর মধ্যে'] }
};
const keys = ['weight','bodyFat','bodyWater','systolic','diastolic','oxygen','bpm','temperature','metabolicAge','visceralFat','healthScore'];
const pageKeys = [[0,1,2],[3,4,5,6,7],[8,9],[0,3,4,5,7],[10]];
const number = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value)>=0 ? Number(value) : null;
export function generateReportSpeech({pageNumber=1,language='hi',vitals={},scanNumber=1}={}) {
    vitals = vitals && typeof vitals === 'object' ? vitals : {};
    const page = Math.max(1,Math.min(5,Math.trunc(Number(pageNumber)||1)));
    const lang = Object.hasOwn(copy,language) ? language : 'hi', c = copy[lang];
    const values = Object.fromEntries(keys.map(key=>[key,number(vitals[key])]));
    const lines = pageKeys[page-1].map(i=>`${c.labels[i]}: ${values[keys[i]] === null ? c.missing : `${values[keys[i]]} ${c.units[i]}`}.`);
    return {ok:true,pageNumber:page,language:lang,scanNumber:Number.isSafeInteger(Number(scanNumber)) && Number(scanNumber)>0 ? Number(scanNumber) : 1,
        script:[c.intro[page-1],...lines,c.note,...(page===5?[c.next]:[])].join(' '),metrics:values};
}
