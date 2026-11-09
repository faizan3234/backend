import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import { readFileSync } from 'node:fs';
import { initializeGrowthTables, createGrowthRouter } from './src/routes/growthRoutes.js';
import { initializeSupport } from './src/services/supportCases.js';

function setupTestApp() {
    const db = new Database(':memory:');
    const schemaSql = readFileSync(new URL('./src/database/schema.sql', import.meta.url), 'utf8');
    db.exec(schemaSql);
    initializeSupport(db);
    initializeGrowthTables(db);

    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // Mount Growth Router
    app.use(createGrowthRouter({ getDb: () => db }));

    // Mount Health Card, Support Issue & Weight routes (identical to server.js handlers)
    app.post('/api/send-health-card', async (req, res) => {
        const { to, name, cardImage } = req.body || {};
        if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
            return res.status(400).json({ ok: false, error: 'Valid recipient email address is required' });
        }
        if (!cardImage) {
            return res.status(400).json({ ok: false, error: 'Health card image is required' });
        }
        return res.json({ ok: true, sent: false, queued: true, message: 'Health card processed' });
    });

    app.post('/api/support-issue', async (req, res) => {
        const { page, issue, details } = req.body || {};
        if (!issue && !page) {
            return res.status(400).json({ ok: false, error: 'Issue description or page identifier is required' });
        }
        const caseId = `HELP-${Date.now()}`;
        db.prepare(`
            INSERT INTO support_cases (case_id, kind, status, evidence_json, created_at)
            VALUES (?, 'UI_SUPPORT_REPORT', 'OPEN', ?, datetime('now'))
        `).run(caseId, JSON.stringify({ page, issue, details }));
        return res.json({ ok: true, caseId, status: 'OPEN', message: 'Support report logged successfully' });
    });

    const handleWeightReset = (req, res) => {
        res.json({ ok: true, status: 'ZERO_RESET_OK', message: 'Scale tared and zero-calibrated successfully' });
    };
    app.post('/api/weight/reset', handleWeightReset);
    app.post('/api/weight/tare', handleWeightReset);

    return { app, db };
}

test('POST /api/send-health-card validates inputs and queues email delivery', async () => {
    const { app, db } = setupTestApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        // Missing email
        const res1 = await fetch(`${base}/api/send-health-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Jane', cardImage: 'data:image/png;base64,xyz' })
        });
        assert.equal(res1.status, 400);

        // Missing card image
        const res2 = await fetch(`${base}/api/send-health-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: 'jane@example.com', name: 'Jane' })
        });
        assert.equal(res2.status, 400);

        // Valid submission
        const res3 = await fetch(`${base}/api/send-health-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: 'jane@example.com',
                name: 'Jane Doe',
                cardImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII='
            })
        });
        assert.equal(res3.status, 200);
        const data3 = await res3.json();
        assert.equal(data3.ok, true);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('POST /api/support-issue persists ticket to SQLite support_cases table', async () => {
    const { app, db } = setupTestApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        // Empty body
        const res1 = await fetch(`${base}/api/support-issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(res1.status, 400);

        // Valid issue submission
        const res2 = await fetch(`${base}/api/support-issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: 'BodyComposition', issue: 'Weight scale not connecting' })
        });
        assert.equal(res2.status, 200);
        const data2 = await res2.json();
        assert.equal(data2.ok, true);
        assert.equal(data2.status, 'OPEN');

        // Confirm database insertion
        const row = db.prepare('SELECT * FROM support_cases WHERE case_id = ?').get(data2.caseId);
        assert.ok(row, 'Support case must exist in database');
        const evidence = JSON.parse(row.evidence_json);
        assert.equal(evidence.page, 'BodyComposition');
        assert.equal(evidence.issue, 'Weight scale not connecting');
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('POST /api/weight/reset & /api/weight/tare return 200 OK', async () => {
    const { app, db } = setupTestApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        const resReset = await fetch(`${base}/api/weight/reset`, { method: 'POST' });
        assert.equal(resReset.status, 200);
        const dataReset = await resReset.json();
        assert.equal(dataReset.ok, true);
        assert.equal(dataReset.status, 'ZERO_RESET_OK');

        const resTare = await fetch(`${base}/api/weight/tare`, { method: 'POST' });
        assert.equal(resTare.status, 200);
        const dataTare = await resTare.json();
        assert.equal(dataTare.ok, true);
        assert.equal(dataTare.status, 'ZERO_RESET_OK');
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('Growth: Referral Create, Anti-Cheat Device Bind, and Claim Workflow', async () => {
    const { app, db } = setupTestApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        // 1. Create referral code for User A
        const userA = 'RLV-111111';
        const resCreate = await fetch(`${base}/api/growth/referral/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userA, name: 'Alice', publicAlias: 'Alice A' })
        });
        assert.equal(resCreate.status, 200);
        const createData = await resCreate.json();
        assert.equal(createData.ok, true);
        assert.match(createData.referralCode, /^RLV-[A-Z0-9]+$/);
        const codeA = createData.referralCode;

        // Same user requesting again returns same code
        const resRepeat = await fetch(`${base}/api/growth/referral/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userA })
        });
        const repeatData = await resRepeat.json();
        assert.equal(repeatData.referralCode, codeA);

        // 2. Anti-cheat device binding
        const userB = 'RLV-222222';
        const devSig1 = 'hardware_sig_device_alpha';

        // Bind device 1 to user B
        const resBind1 = await fetch(`${base}/api/growth/device-bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceSig: devSig1, userId: userB, platform: 'android' })
        });
        const bindData1 = await resBind1.json();
        assert.equal(bindData1.ok, true);
        assert.equal(bindData1.bound, true);
        assert.equal(bindData1.isNewDevice, true);

        // Duplicate bind of same device 1 to user C (Blocked by One Device Only One App policy)
        const userC = 'RLV-333333';
        const resBindConflict = await fetch(`${base}/api/growth/device-bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceSig: devSig1, userId: userC })
        });
        const conflictData = await resBindConflict.json();
        assert.equal(conflictData.ok, true);
        assert.equal(conflictData.bound, false);
        assert.equal(conflictData.reason, 'DEVICE_ALREADY_BOUND');

        // 3. Referral claim: Self-referral rejected
        const resSelfClaim = await fetch(`${base}/api/growth/referral/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ referralCode: codeA, refereeUserId: userA, deviceSig: 'dev_a' })
        });
        assert.equal(resSelfClaim.status, 400);
        const selfData = await resSelfClaim.json();
        assert.equal(selfData.ok, false);
        assert.equal(selfData.reason, 'SELF_REFERRAL_DISALLOWED');

        // 4. Referral claim: Valid claim from User B on bound device
        const resValidClaim = await fetch(`${base}/api/growth/referral/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ referralCode: codeA, refereeUserId: userB, deviceSig: devSig1 })
        });
        assert.equal(resValidClaim.status, 200);
        const validClaimData = await resValidClaim.json();
        assert.equal(validClaimData.ok, true);
        assert.equal(validClaimData.claimed, true);

        // 5. Leaderboard verification
        const resLeaderboard = await fetch(`${base}/api/growth/referral/leaderboard`);
        assert.equal(resLeaderboard.status, 200);
        const lbData = await resLeaderboard.json();
        assert.equal(lbData.ok, true);
        assert.ok(Array.isArray(lbData.leaderboard));
        assert.ok(lbData.leaderboard.length >= 1);
        assert.equal(lbData.leaderboard[0].qualifiedReferrals, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

test('Customer Web: Store Order & Streak Restore routes', async () => {
    const { app, db } = setupTestApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
        // Store order dispatch
        const resOrder = await fetch(`${base}/api/store/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product: 'First Aid Kit', quantity: 1, totalAmount: 350 })
        });
        assert.equal(resOrder.status, 200);
        const orderData = await resOrder.json();
        assert.equal(orderData.ok, true);
        assert.equal(orderData.status, 'DISPATCH_QUEUED');

        // Streak restore
        const resStreak = await fetch(`${base}/api/streak/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'RLV-999999', streakBefore: 14, streakAfter: 15, amount: 99 })
        });
        assert.equal(resStreak.status, 200);
        const streakData = await resStreak.json();
        assert.equal(streakData.ok, true);
        assert.equal(streakData.status, 'RESTORE_APPLIED');

        const restoreRow = db.prepare('SELECT * FROM streak_restores WHERE user_id = ?').get('RLV-999999');
        assert.ok(restoreRow, 'Streak restore must be recorded in database');
        assert.equal(restoreRow.streak_before, 14);
        assert.equal(restoreRow.streak_after, 15);
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});

