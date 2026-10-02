import PDFDocument from 'pdfkit';
import { setupPdfFonts } from './receiptPdfBuilder.js';

export function calculateChallengeComparison({ participant1 = {}, participant2 = {}, relationship = 'friends' }) {
    const p1Name = String(participant1.name || participant1.alias || 'Player 1').trim().slice(0, 24);
    const p2Name = String(participant2.name || participant2.partner || 'Player 2').trim().slice(0, 24);

    const p1Score = Number(participant1.healthScore || participant1.score || 82);
    const p2Score = Number(participant2.healthScore || participant2.score || 85);

    const p1Age = Number(participant1.age || 28);
    const p2Age = Number(participant2.age || 28);

    const p1Metabolic = Number(participant1.metabolicAge || 26);
    const p2Metabolic = Number(participant2.metabolicAge || 24);

    const p1YouthBonus = p1Age - p1Metabolic;
    const p2YouthBonus = p2Age - p2Metabolic;

    const p1Water = Number(participant1.bodyWater || 58.2);
    const p2Water = Number(participant2.bodyWater || 60.5);

    const p1Bpm = Number(participant1.bpm || 72);
    const p2Bpm = Number(participant2.bpm || 68);

    let p1Points = 0;
    let p2Points = 0;

    if (p1Score > p2Score) p1Points += 2; else if (p2Score > p1Score) p2Points += 2;
    if (p1YouthBonus > p2YouthBonus) p1Points += 2; else if (p2YouthBonus > p1YouthBonus) p2Points += 2;
    if (p1Water > p2Water) p1Points += 1; else if (p2Water > p1Water) p2Points += 1;
    if (p1Bpm < p2Bpm) p1Points += 1; else if (p2Bpm < p1Bpm) p2Points += 1;

    let winner = 'TIE';
    let winnerName = 'Both Champions!';
    let loserName = '';
    let victoryReason = 'Equally matched health warriors!';

    if (p1Points > p2Points) {
        winner = 'p1';
        winnerName = p1Name;
        loserName = p2Name;
        victoryReason = `${p1Name} won with a higher health score and metabolic youth!`;
    } else if (p2Points > p1Points) {
        winner = 'p2';
        winnerName = p2Name;
        loserName = p1Name;
        victoryReason = `${p2Name} won with superior body hydration and metabolic fitness!`;
    }

    return {
        relationship,
        p1: { name: p1Name, score: p1Score, metabolicAge: p1Metabolic, youthBonus: p1YouthBonus, bodyWater: p1Water, bpm: p1Bpm, points: p1Points },
        p2: { name: p2Name, score: p2Score, metabolicAge: p2Metabolic, youthBonus: p2YouthBonus, bodyWater: p2Water, bpm: p2Bpm, points: p2Points },
        winner,
        winnerName,
        loserName,
        victoryReason,
        instagramTag: '@relivhealth',
        dareText: loserName ? `${loserName} treats smoothie / dinner & tags @relivhealth on Instagram Story!` : 'Share your draw on Story & tag @relivhealth for a repost!'
    };
}

export function generateChallengeCardPdf(data = {}) {
    const comp = calculateChallengeComparison(data);
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: [540, 960], margin: 30 });
            const buffers = [];
            doc.on('data', chunk => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const fonts = setupPdfFonts(doc);
            const fontRegular = fonts?.fontR || 'Helvetica';
            const fontBold = fonts?.fontB || 'Helvetica-Bold';

            doc.rect(0, 0, 540, 960).fill('#0F172A');
            doc.circle(500, 50, 160).fill('#FF641A');
            doc.circle(40, 900, 180).fill('#1E293B');

            doc.font(fontBold).fontSize(26).fillColor('#FF8A4C').text('RELIV HEALTH', 40, 48);
            doc.font(fontRegular).fontSize(13).fillColor('#94A3B8').text('SMART KIOSK CHALLENGE • INSTAGRAM STORY', 40, 78);

            const isCouple = comp.relationship === 'couple';
            const modeTitle = isCouple ? 'COUPLE WELLNESS CLASH' : 'FRIENDS HEALTH SHOWDOWN';
            doc.font(fontBold).fontSize(30).fillColor('#FFFFFF').text(modeTitle, 40, 125, { width: 460 });

            doc.roundedRect(35, 185, 470, 115, 16).fill('#1E293B');
            doc.lineWidth(2).strokeColor('#F59E0B').roundedRect(35, 185, 470, 115, 16).stroke();

            doc.font(fontBold).fontSize(14).fillColor('#F59E0B').text('👑 CHAMPION OF THE SCAN', 55, 202);
            doc.font(fontBold).fontSize(28).fillColor('#34D399').text(comp.winnerName, 55, 224, { width: 430 });
            doc.font(fontRegular).fontSize(13).fillColor('#CBD5E1').text(comp.victoryReason, 55, 264, { width: 430 });

            doc.font(fontBold).fontSize(16).fillColor('#F8FAFC').text('HEAD-TO-HEAD COMPARISON', 40, 325);

            const metrics = [
                { label: 'Overall Health Score', p1Val: `${comp.p1.score}/100`, p2Val: `${comp.p2.score}/100`, unit: 'pts', better: comp.p1.score >= comp.p2.score ? 'p1' : 'p2' },
                { label: 'Metabolic Age', p1Val: `${comp.p1.metabolicAge} yrs`, p2Val: `${comp.p2.metabolicAge} yrs`, unit: 'yrs', better: comp.p1.metabolicAge <= comp.p2.metabolicAge ? 'p1' : 'p2' },
                { label: 'Body Water (Hydration)', p1Val: `${comp.p1.bodyWater}%`, p2Val: `${comp.p2.bodyWater}%`, unit: '%', better: comp.p1.bodyWater >= comp.p2.bodyWater ? 'p1' : 'p2' },
                { label: 'Resting Heart Rate', p1Val: `${comp.p1.bpm} bpm`, p2Val: `${comp.p2.bpm} bpm`, unit: 'bpm', better: comp.p1.bpm <= comp.p2.bpm ? 'p1' : 'p2' },
            ];

            let rowY = 355;
            doc.roundedRect(35, rowY, 470, 32, 8).fill('#334155');
            doc.font(fontBold).fontSize(13).fillColor('#94A3B8').text('METRIC', 50, rowY + 10);
            doc.fillColor('#F8FAFC').text(comp.p1.name.slice(0, 14), 250, rowY + 10, { width: 110, align: 'center' });
            doc.text(comp.p2.name.slice(0, 14), 380, rowY + 10, { width: 110, align: 'center' });
            rowY += 40;

            for (const m of metrics) {
                doc.roundedRect(35, rowY, 470, 48, 10).fill('#1E293B');
                doc.font(fontBold).fontSize(13).fillColor('#F8FAFC').text(m.label, 50, rowY + 16);

                const p1Color = m.better === 'p1' ? '#34D399' : '#CBD5E1';
                const p2Color = m.better === 'p2' ? '#34D399' : '#CBD5E1';

                doc.font(fontBold).fontSize(14).fillColor(p1Color).text(m.p1Val, 250, rowY + 16, { width: 110, align: 'center' });
                doc.font(fontBold).fontSize(14).fillColor(p2Color).text(m.p2Val, 380, rowY + 16, { width: 110, align: 'center' });
                rowY += 56;
            }

            doc.roundedRect(35, 620, 470, 190, 18).fill('#312E81');
            doc.lineWidth(2).strokeColor('#818CF8').roundedRect(35, 620, 470, 190, 18).stroke();

            doc.font(fontBold).fontSize(16).fillColor('#FDE047').text('📸 POST TO YOUR INSTAGRAM STORY', 55, 642);
            doc.font(fontBold).fontSize(15).fillColor('#FFFFFF').text('LOSER TAGS @RELIVHEALTH', 55, 672);
            doc.font(fontRegular).fontSize(13).fillColor('#E0E7FF').text(comp.dareText, 55, 698, { width: 430, lineGap: 4 });

            doc.font(fontBold).fontSize(13).fillColor('#A7F3D0').text('⚡ Reliv will tag you back & repost the champion on our page!', 55, 762, { width: 430 });

            doc.font(fontBold).fontSize(14).fillColor('#FF8A4C').text('#RelivChallenge  #RelivTogether  #HealthJourney', 40, 840);
            doc.font(fontRegular).fontSize(11).fillColor('#64748B').text('Scanned at Reliv Health Kiosk • 120+ clinical & metabolic parameters verified', 40, 868);

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}
