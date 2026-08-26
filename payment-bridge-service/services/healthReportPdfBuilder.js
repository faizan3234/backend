import PDFDocument from 'pdfkit';
import { setupPdfFonts } from './receiptPdfBuilder.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const CONTENT_W = PAGE_W - (M * 2);
const BOTTOM = 792;

const C = {
    navy: '#172033',
    secondary: '#667085',
    orange: '#FF641A',
    paleOrange: '#FFF4ED',
    green: '#15803D',
    paleGreen: '#ECFDF3',
    surface: '#FCFCFD',
    border: '#E4E7EC',
    text: '#344054',
    white: '#FFFFFF',
    red: '#B42318'
};

const hasValue = (v) =>
    v !== undefined &&
    v !== null &&
    String(v).trim() !== '';

const numberOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const formatDate = (ms) => {
    const d = new Date(Number(ms) || Date.now());
    return d.toLocaleDateString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
};

const formatValue = (value, unit = '') => {
    if (!hasValue(value)) return 'Not recorded';
    const text = String(value);
    return unit ? `${text} ${unit}` : text;
};

const safeText = (value, fallback = 'Not recorded') =>
    hasValue(value) ? String(value) : fallback;

const scanTier = (scanNumber) => {
    const tier = Math.min(Math.max(Number(scanNumber) || 1, 1), 7);
    const names = {
        1: 'Essential Health Snapshot',
        2: 'Comparison Unlocked',
        3: 'Body Composition Trends',
        4: 'Wellness Focus',
        5: 'Trend Review',
        6: 'Health Journey',
        7: 'Complete Longitudinal Report'
    };
    return { tier, name: names[tier] };
};

export function buildHealthReportModel({ scans, currentScanNumber, recipientEmail }) {
    if (!Array.isArray(scans) || scans.length === 0) {
        throw new Error('At least one authoritative health scan is required');
    }

    const ordered = [...scans].sort((a, b) => a.scanNumber - b.scanNumber);
    const latest = ordered.find(s => s.scanNumber === currentScanNumber) || ordered[ordered.length - 1];

    if (!latest?.snapshot?.patient || !latest?.snapshot?.vitals) {
        throw new Error('Latest health scan is missing patient or vitals data');
    }

    const tierInfo = scanTier(currentScanNumber);

    return {
        scans: ordered,
        latest,
        patient: latest.snapshot.patient,
        vitals: latest.snapshot.vitals,
        currentScanNumber: Number(currentScanNumber) || ordered.length,
        totalScans: ordered.length,
        tier: tierInfo.tier,
        tierName: tierInfo.name,
        recipientEmail: recipientEmail || '',
        generatedAt: Date.now()
    };
}

function comparisonRows(current, previous) {
    if (!previous) return [];

    const defs = [
        ['systolic', 'Systolic BP', 'mmHg'],
        ['diastolic', 'Diastolic BP', 'mmHg'],
        ['bpm', 'Heart Rate', 'bpm'],
        ['oxygen', 'SpOâ‚‚', '%'],
        ['temperature', 'Temperature', 'Â°F'],
        ['weight', 'Weight', 'kg'],
        ['bodyFat', 'Body Fat', '%'],
        ['muscleMass', 'Muscle Mass', 'kg'],
        ['bodyWater', 'Body Water', '%']
    ];

    return defs.flatMap(([key, label, unit]) => {
        const cur = numberOrNull(current?.[key]);
        const prev = numberOrNull(previous?.[key]);
        if (cur === null || prev === null) return [];
        const delta = cur - prev;
        const deltaText = Math.abs(delta) < 0.0001
            ? 'No change'
            : `${delta > 0 ? '+' : ''}${delta.toFixed(Math.abs(delta) < 10 ? 1 : 0)} ${unit}`;
        return [{
            key,
            label,
            previous: `${prev} ${unit}`,
            current: `${cur} ${unit}`,
            delta: deltaText
        }];
    });
}

function trendDirection(scans, key, unit) {
    const pts = scans
        .map(s => ({ n: s.scanNumber, v: numberOrNull(s.snapshot?.vitals?.[key]) }))
        .filter(p => p.v !== null);

    if (pts.length < 2) return null;

    const first = pts[0];
    const last = pts[pts.length - 1];
    const delta = last.v - first.v;
    const direction = Math.abs(delta) < 0.05 ? 'stable' : (delta > 0 ? 'increased' : 'decreased');

    return {
        first: first.v,
        last: last.v,
        direction,
        delta: `${delta > 0 ? '+' : ''}${delta.toFixed(Math.abs(delta) < 10 ? 1 : 0)} ${unit}`
    };
}

export async function generateCloudHealthReportPdfBuffer({
    scans,
    currentScanNumber,
    recipientEmail = ''
}) {
    const model = buildHealthReportModel({
        scans,
        currentScanNumber,
        recipientEmail
    });

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 0, bottom: 0, left: 0, right: 0 },
                autoFirstPage: false,
                bufferPages: true
            });

            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const { fontR, fontB } = setupPdfFonts(doc);
            let y = 0;

            const addPage = (continued = false) => {
                doc.addPage({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
                doc.rect(0, 0, PAGE_W, PAGE_H).fill(C.white);

                if (continued) {
                    doc.font(fontB).fontSize(13).fillColor(C.navy)
                        .text('RELIV', M, 25, { width: 80 });
                    doc.font(fontR).fontSize(8).fillColor(C.secondary)
                        .text(`Health Report â€¢ Scan ${model.currentScanNumber}`, M + 80, 28, {
                            width: CONTENT_W - 80,
                            align: 'right'
                        });
                    doc.moveTo(M, 48).lineTo(PAGE_W - M, 48).strokeColor(C.border).lineWidth(0.7).stroke();
                    y = 64;
                } else {
                    doc.roundedRect(M, 28, CONTENT_W, 108, 16).fill(C.surface);
                    doc.font(fontB).fontSize(25).fillColor(C.navy)
                        .text('RELIV', M + 20, 44, { width: 130 });
                    doc.font(fontB).fontSize(18).fillColor(C.navy)
                        .text('Health Report', M + 20, 74, { width: 260 });
                    doc.font(fontR).fontSize(8.5).fillColor(C.secondary)
                        .text('Secure progressive wellness tracking report', M + 20, 99, { width: 300 });

                    doc.roundedRect(PAGE_W - M - 150, 46, 130, 56, 12).fill(C.paleOrange);
                    doc.font(fontB).fontSize(10).fillColor(C.orange)
                        .text(`SCAN ${model.currentScanNumber}`, PAGE_W - M - 138, 58, {
                            width: 106,
                            align: 'center'
                        });
                    doc.font(fontB).fontSize(8.5).fillColor(C.navy)
                        .text(model.tierName, PAGE_W - M - 138, 77, {
                            width: 106,
                            align: 'center'
                        });
                    y = 154;
                }
            };

            const ensure = (height) => {
                if (y + height > BOTTOM) addPage(true);
            };

            const title = (text, subtitle = '') => {
                ensure(subtitle ? 48 : 32);
                doc.font(fontB).fontSize(13).fillColor(C.navy).text(text, M, y, { width: CONTENT_W });
                y += 20;
                if (subtitle) {
                    doc.font(fontR).fontSize(8.5).fillColor(C.secondary)
                        .text(subtitle, M, y, { width: CONTENT_W, lineGap: 2 });
                    y += 20;
                }
            };

            const card = (height, draw) => {
                ensure(height + 10);
                const top = y;
                doc.roundedRect(M, top, CONTENT_W, height, 12)
                    .fillAndStroke(C.surface, C.border);
                draw(top);
                y = top + height + 12;
            };

            const drawMetricGrid = (metrics) => {
                const visible = metrics.filter(m => hasValue(m.value));
                if (visible.length === 0) return;

                const cols = 3;
                const gap = 9;
                const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
                const rows = Math.ceil(visible.length / cols);
                const h = rows * 63 + (rows - 1) * gap;

                ensure(h + 8);

                visible.forEach((m, i) => {
                    const row = Math.floor(i / cols);
                    const col = i % cols;
                    const x = M + col * (cellW + gap);
                    const top = y + row * (63 + gap);

                    doc.roundedRect(x, top, cellW, 63, 10).fillAndStroke(C.surface, C.border);
                    doc.font(fontR).fontSize(7.5).fillColor(C.secondary)
                        .text(m.label, x + 10, top + 11, { width: cellW - 20 });
                    doc.font(fontB).fontSize(13).fillColor(C.navy)
                        .text(formatValue(m.value, m.unit), x + 10, top + 29, {
                            width: cellW - 20,
                            ellipsis: true
                        });
                });

                y += h + 12;
            };

            addPage(false);

            // Patient identity / scan metadata
            card(86, (top) => {
                doc.font(fontB).fontSize(11).fillColor(C.navy)
                    .text(safeText(model.patient.name, 'Customer'), M + 16, top + 14, { width: 240 });

                doc.font(fontR).fontSize(8.5).fillColor(C.secondary)
                    .text(
                        `Age: ${safeText(model.patient.age)}   â€¢   Gender: ${safeText(model.patient.gender)}`,
                        M + 16,
                        top + 35,
                        { width: 300 }
                    );

                if (model.recipientEmail) {
                    doc.font(fontR).fontSize(8).fillColor(C.secondary)
                        .text(`Delivered to: ${model.recipientEmail}`, M + 16, top + 54, { width: 310 });
                }

                doc.font(fontB).fontSize(10).fillColor(C.orange)
                    .text(`${model.currentScanNumber}${model.currentScanNumber === 1 ? 'st' : model.currentScanNumber === 2 ? 'nd' : model.currentScanNumber === 3 ? 'rd' : 'th'} Health Check`,
                        PAGE_W - M - 165, top + 20, { width: 145, align: 'right' });

                doc.font(fontR).fontSize(8).fillColor(C.secondary)
                    .text(`${model.totalScans} paid scan${model.totalScans === 1 ? '' : 's'} linked`,
                        PAGE_W - M - 165, top + 43, { width: 145, align: 'right' });
            });

            title(
                'Current Measurements',
                'Only measurements received in the signed kiosk snapshot are shown. Missing values are not fabricated.'
            );

            const v = model.vitals;

            drawMetricGrid([
                { label: 'Systolic BP', value: v.systolic, unit: 'mmHg' },
                { label: 'Diastolic BP', value: v.diastolic, unit: 'mmHg' },
                { label: 'Heart Rate', value: v.bpm, unit: 'bpm' },
                { label: 'Blood Oxygen', value: v.oxygen, unit: '%' },
                { label: 'Body Temperature', value: v.temperature, unit: 'Â°F' },
                { label: 'Weight', value: v.weight, unit: 'kg' },
                { label: 'Height', value: v.height, unit: 'cm' },
                { label: 'Left Eye', value: v.leftEye, unit: '' },
                { label: 'Right Eye', value: v.rightEye, unit: '' }
            ]);

            const bodyMetrics = [
                { label: 'Body Fat', value: v.bodyFat, unit: '%' },
                { label: 'Muscle Mass', value: v.muscleMass, unit: 'kg' },
                { label: 'Bone Mass', value: v.boneMass, unit: 'kg' },
                { label: 'Body Water', value: v.bodyWater, unit: '%' },
                { label: 'Skeletal Muscle', value: v.skeletalMuscle, unit: '%' },
                { label: 'FFMI', value: v.ffmi, unit: '' },
                { label: 'BMR', value: v.bmr, unit: 'kcal/day' },
                { label: 'Metabolic Age', value: v.metabolicAge, unit: 'years' },
                { label: 'Impedance', value: v.impedance, unit: 'Î©' }
            ].filter(m => hasValue(m.value));

            if (bodyMetrics.length) {
                title('Body Composition');
                drawMetricGrid(bodyMetrics);
            }

            // Scan 2+: comparison unlock.
            if (model.currentScanNumber >= 2) {
                const previous = model.scans
                    .filter(s => s.scanNumber < model.currentScanNumber)
                    .slice(-1)[0];

                const rows = comparisonRows(model.vitals, previous?.snapshot?.vitals);

                if (rows.length) {
                    title(
                        'Previous Scan Comparison',
                        `Comparison against Scan ${previous.scanNumber}. Changes are shown descriptively, not as a diagnosis.`
                    );

                    ensure(30 + rows.length * 25);
                    const start = y;
                    const widths = [200, 105, 105, 113];
                    const headers = ['Metric', 'Previous', 'Current', 'Change'];
                    let x = M;

                    headers.forEach((h, i) => {
                        doc.rect(x, start, widths[i], 24).fill(C.navy);
                        doc.font(fontB).fontSize(7.5).fillColor(C.white)
                            .text(h, x + 7, start + 8, { width: widths[i] - 14 });
                        x += widths[i];
                    });

                    let rowY = start + 24;
                    rows.forEach((r, idx) => {
                        x = M;
                        const values = [r.label, r.previous, r.current, r.delta];
                        values.forEach((value, i) => {
                            doc.rect(x, rowY, widths[i], 25)
                                .fillAndStroke(idx % 2 ? C.white : C.surface, C.border);
                            doc.font(i === 0 ? fontB : fontR).fontSize(7.5).fillColor(C.text)
                                .text(value, x + 7, rowY + 8, { width: widths[i] - 14 });
                            x += widths[i];
                        });
                        rowY += 25;
                    });

                    y = rowY + 12;
                }
            }

            // Scan 3+: progressive body-composition trajectory.
            if (model.currentScanNumber >= 3) {
                title(
                    'Progressive Trend Snapshot',
                    'A compact view of selected measurements across your paid Reliv scans.'
                );

                const history = model.scans.slice(-8);
                ensure(28 + history.length * 25);

                const cols = [
                    ['Scan', 48],
                    ['Date', 88],
                    ['BP', 94],
                    ['HR', 66],
                    ['SpOâ‚‚', 66],
                    ['Weight', 78],
                    ['Body Fat', 83]
                ];

                let x = M;
                cols.forEach(([label, w]) => {
                    doc.rect(x, y, w, 24).fill(C.navy);
                    doc.font(fontB).fontSize(7).fillColor(C.white)
                        .text(label, x + 5, y + 8, { width: w - 10 });
                    x += w;
                });

                y += 24;

                history.forEach((scan, idx) => {
                    const sv = scan.snapshot?.vitals || {};
                    const bp = hasValue(sv.systolic) || hasValue(sv.diastolic)
                        ? `${safeText(sv.systolic, 'â€”')}/${safeText(sv.diastolic, 'â€”')}`
                        : 'â€”';

                    const values = [
                        `#${scan.scanNumber}`,
                        formatDate(scan.createdAt),
                        bp,
                        hasValue(sv.bpm) ? `${sv.bpm}` : 'â€”',
                        hasValue(sv.oxygen) ? `${sv.oxygen}%` : 'â€”',
                        hasValue(sv.weight) ? `${sv.weight} kg` : 'â€”',
                        hasValue(sv.bodyFat) ? `${sv.bodyFat}%` : 'â€”'
                    ];

                    x = M;
                    cols.forEach(([, w], i) => {
                        doc.rect(x, y, w, 25)
                            .fillAndStroke(idx % 2 ? C.white : C.surface, C.border);
                        doc.font(i === 0 ? fontB : fontR).fontSize(7).fillColor(C.text)
                            .text(values[i], x + 5, y + 8, { width: w - 10 });
                        x += w;
                    });
                    y += 25;
                });

                y += 12;
            }

            // Scan 4+: conservative wellness guidance.
            if (model.currentScanNumber >= 4) {
                title('Wellness Focus');
                card(92, (top) => {
                    const bullets = [
                        'Use trends across multiple scans rather than treating one reading as a diagnosis.',
                        'For meaningful comparison, try to measure under similar conditions each visit.',
                        'If a reading is repeatedly concerning or you have symptoms, consult a qualified healthcare professional.'
                    ];

                    let by = top + 14;
                    bullets.forEach((b) => {
                        doc.circle(M + 19, by + 4, 2.2).fill(C.orange);
                        doc.font(fontR).fontSize(8.2).fillColor(C.text)
                            .text(b, M + 30, by, { width: CONTENT_W - 46, lineGap: 1.5 });
                        by += 24;
                    });
                });
            }

            // Scan 5+: descriptive direction summary only.
            if (model.currentScanNumber >= 5) {
                title(
                    'Trend Review',
                    'Direction is calculated from your earliest available value to the latest available value; it is not a clinical interpretation.'
                );

                const trendDefs = [
                    ['weight', 'Weight', 'kg'],
                    ['bodyFat', 'Body Fat', '%'],
                    ['muscleMass', 'Muscle Mass', 'kg'],
                    ['bpm', 'Heart Rate', 'bpm'],
                    ['oxygen', 'Blood Oxygen', '%']
                ];

                const trends = trendDefs
                    .map(([key, label, unit]) => ({
                        label,
                        unit,
                        data: trendDirection(model.scans, key, unit)
                    }))
                    .filter(t => t.data);

                if (trends.length) {
                    const h = Math.max(72, Math.ceil(trends.length / 2) * 52 + 12);
                    card(h, (top) => {
                        const cellW = (CONTENT_W - 42) / 2;
                        trends.forEach((t, i) => {
                            const row = Math.floor(i / 2);
                            const col = i % 2;
                            const x = M + 16 + col * (cellW + 10);
                            const ty = top + 13 + row * 52;

                            doc.font(fontB).fontSize(8.5).fillColor(C.navy)
                                .text(t.label, x, ty, { width: cellW });
                            doc.font(fontR).fontSize(7.5).fillColor(C.secondary)
                                .text(
                                    `${t.data.direction} â€¢ ${t.data.delta} overall`,
                                    x,
                                    ty + 17,
                                    { width: cellW }
                                );
                        });
                    });
                }
            }

            // Scan 6+: full journey list.
            if (model.currentScanNumber >= 6) {
                title('Health Journey');
                const rows = model.scans.map(scan => {
                    const sv = scan.snapshot?.vitals || {};
                    return `Scan ${scan.scanNumber} â€¢ ${formatDate(scan.createdAt)} â€¢ ${hasValue(sv.weight) ? `Weight ${sv.weight} kg` : 'weight not recorded'} â€¢ ${hasValue(sv.oxygen) ? `SpOâ‚‚ ${sv.oxygen}%` : 'SpOâ‚‚ not recorded'}`;
                });

                const h = Math.min(180, 24 + rows.length * 18);
                ensure(h);
                rows.forEach((text) => {
                    ensure(20);
                    doc.circle(M + 4, y + 5, 2).fill(C.green);
                    doc.font(fontR).fontSize(8).fillColor(C.text)
                        .text(text, M + 14, y, { width: CONTENT_W - 14 });
                    y += 18;
                });
                y += 6;
            }

            // Scan 7+: complete tier.
            if (model.currentScanNumber >= 7) {
                title('Complete Longitudinal Report');
                card(78, (top) => {
                    doc.font(fontB).fontSize(10).fillColor(C.green)
                        .text('Full report tier unlocked', M + 16, top + 14, { width: CONTENT_W - 32 });
                    doc.font(fontR).fontSize(8.2).fillColor(C.text)
                        .text(
                            `You now have ${model.totalScans} paid Reliv scans linked to this report history. Future scans continue this same history; the report does not reset after Scan 7.`,
                            M + 16,
                            top + 35,
                            { width: CONTENT_W - 32, lineGap: 2 }
                        );
                });
            }

            title('Important Note');
            card(74, (top) => {
                doc.font(fontR).fontSize(8).fillColor(C.text)
                    .text(
                        'This report is intended for wellness tracking and informational use. It is not a diagnosis, medical prescription, or substitute for professional medical evaluation. Seek medical care for concerning symptoms or persistently unusual readings.',
                        M + 16,
                        top + 15,
                        { width: CONTENT_W - 32, lineGap: 2.2 }
                    );
            });

            // Footer / page numbering.
            const range = doc.bufferedPageRange();
            for (let i = 0; i < range.count; i++) {
                doc.switchToPage(range.start + i);
                doc.moveTo(M, PAGE_H - 35).lineTo(PAGE_W - M, PAGE_H - 35)
                    .strokeColor(C.border).lineWidth(0.6).stroke();
                doc.font(fontR).fontSize(7).fillColor(C.secondary)
                    .text(
                        `Reliv Health â€¢ Page ${i + 1} of ${range.count}`,
                        M,
                        PAGE_H - 25,
                        { width: CONTENT_W / 2 }
                    );
                doc.font(fontR).fontSize(7).fillColor(C.secondary)
                    .text(
                        'relivcustomercare.in@gmail.com',
                        M + CONTENT_W / 2,
                        PAGE_H - 25,
                        { width: CONTENT_W / 2, align: 'right' }
                    );
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

export default {
    buildHealthReportModel,
    generateCloudHealthReportPdfBuffer
};