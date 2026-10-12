import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyEstimates, getAllDerivedParameters } from './src/services/bodyEstimates.js';
import { calculateChallengeComparison, generateChallengeCardPdf } from './src/services/challengeCardService.js';
import { generateReportSpeech } from './src/services/reportSpeechService.js';

test('bodyEstimates calculates metabolic age, visceral fat, body water and full composition', () => {
    const vitals = {
        height: 175,
        weight: 70,
        systolic: 118,
        diastolic: 78,
        bpm: 72,
        oxygen: 98,
        temperature: 98.4
    };
    const patient = { age: 30, gender: 'male' };
    const est = bodyEstimates(vitals, patient);

    // Metabolic Age must be available and realistic
    assert(Number.isFinite(est.metabolicAge), 'metabolicAge must be a valid number');
    assert(est.metabolicAge >= 15 && est.metabolicAge <= 90, `metabolicAge ${est.metabolicAge} in realistic range`);

    // Visceral Fat must be available
    assert(Number.isFinite(est.visceralFat), 'visceralFat must be a valid number');
    assert(est.visceralFat >= 1 && est.visceralFat <= 25, `visceralFat ${est.visceralFat} within 1-25 scale`);

    // Body Water & compartments
    assert(Number.isFinite(est.bodyWater), 'bodyWater % must be a number');
    assert(est.bodyWater >= 45 && est.bodyWater <= 75, `bodyWater ${est.bodyWater}% realistic`);
    assert(Number.isFinite(est.bodyWaterLitres), 'bodyWaterLitres must be a number');
    assert(Number.isFinite(est.intracellularWaterLitres), 'intracellularWaterLitres must be a number');
    assert(Number.isFinite(est.extracellularWaterLitres), 'extracellularWaterLitres must be a number');

    // Hemodynamics & Vitals calculations
    assert.equal(est.pulsePressure, 40, 'pulsePressure = 118 - 78 = 40');
    assert(Number.isFinite(est.meanArterialPressure), 'meanArterialPressure must be calculated');
    assert.equal(est.ratePressureProduct, Math.round((118 * 72) / 100), 'ratePressureProduct matches formula');

    // Health Score
    assert(Number.isFinite(est.healthScore), 'healthScore must be calculated');
    assert(est.healthScore >= 35 && est.healthScore <= 100, 'healthScore in 35-100 range');
});

test('getAllDerivedParameters provides 120+ clinical reference metrics with traffic-light status', () => {
    const vitals = { height: 172, weight: 68, systolic: 124, diastolic: 82, bpm: 75, oxygen: 98, temperature: 98.6 };
    const patient = { age: 28, gender: 'female' };

    const scan1Params = getAllDerivedParameters(vitals, patient, 1);
    const scan2Params = getAllDerivedParameters(vitals, patient, 2);
    const scan3Params = getAllDerivedParameters(vitals, patient, 3);

    // Verify parameter structure
    for (const p of scan1Params) {
        assert(p.id, 'Parameter has id');
        assert(p.name, 'Parameter has name');
        assert(p.category, 'Parameter has category');
        assert(p.value !== undefined, `Parameter ${p.id} has value`);
        assert(['good', 'caution', 'warning'].includes(p.status), `Parameter ${p.id} status is traffic-light`);
        assert(['green', 'yellow', 'red'].includes(p.color), `Parameter ${p.id} color is green/yellow/red`);
        assert(p.description, `Parameter ${p.id} has day-to-day description`);
    }

    // Verify progressive scan unlocking
    const unlockedScan1 = scan1Params.filter(p => p.isUnlocked);
    const unlockedScan2 = scan2Params.filter(p => p.isUnlocked);
    const unlockedScan3 = scan3Params.filter(p => p.isUnlocked);

    assert.equal(unlockedScan1.length, 16, 'Scan 1 unlocks exactly first 16 metrics');
    assert.equal(unlockedScan2.length, 32, 'Scan 2 unlocks 32 metrics (16 + 16)');
    assert.equal(unlockedScan3.length, 48, 'Scan 3 unlocks 48 metrics');
});

test('calculateChallengeComparison accurately compares health metrics and determines winner', () => {
    const comparison = calculateChallengeComparison({
        participant1: { name: 'Aman', healthScore: 88, age: 30, metabolicAge: 25, bodyWater: 62.0, bpm: 68 },
        participant2: { name: 'Priya', healthScore: 82, age: 28, metabolicAge: 27, bodyWater: 56.5, bpm: 75 },
        relationship: 'couple'
    });

    assert.equal(comparison.winner, 'p1', 'Aman wins with higher score and greater metabolic youth');
    assert.equal(comparison.winnerName, 'Aman');
    assert.equal(comparison.loserName, 'Priya');
    assert(comparison.dareText.includes('@relivhealth'), 'Dare mentions @relivhealth');
});

test('generateChallengeCardPdf builds valid 9:16 Instagram Story PDF buffer', async () => {
    const pdfBuf = await generateChallengeCardPdf({
        participant1: { name: 'Faizan', healthScore: 92, age: 26, metabolicAge: 22, bodyWater: 64.0, bpm: 64 },
        participant2: { name: 'Rahul', healthScore: 84, age: 27, metabolicAge: 26, bodyWater: 58.0, bpm: 74 },
        relationship: 'friends'
    });

    assert(Buffer.isBuffer(pdfBuf), 'Result is a Buffer');
    assert(pdfBuf.length > 5000, 'PDF buffer is non-trivial size');
    assert.equal(pdfBuf.toString('ascii', 0, 4), '%PDF', 'Buffer starts with PDF magic header');
});

test('report speech uses supplied readings in every language without invented normal values', () => {
    for (const language of ['en','hi','bn']) {
        for (let pageNumber=1;pageNumber<=5;pageNumber++) {
            const missing=generateReportSpeech({pageNumber,language,vitals:{}});
            assert(Object.values(missing.metrics).every(value=>value===null));
            assert(!/120|98.4|18.5|58.2|82|scan 2|green zone/.test(missing.script));
        }
        const report=generateReportSpeech({pageNumber:2,language,vitals:{systolic:180,diastolic:110,oxygen:88,bpm:120,temperature:39}});
        assert(report.script.includes('180') && report.script.includes('88'));
        assert(!/optimal|safe zone|strong|healthy range|normal/.test(report.script));
        const summary=generateReportSpeech({pageNumber:5,language,vitals:{healthScore:98},scanNumber:8});
        assert.equal(summary.metrics.healthScore,98);assert.equal(summary.scanNumber,8);
        assert(summary.script.includes('98'));
    }
    assert.equal(generateReportSpeech({vitals:{weight:''}}).metrics.weight,null);
    assert.equal(generateReportSpeech({vitals:{weight:Infinity}}).metrics.weight,null);
});
