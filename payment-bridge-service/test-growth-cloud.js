import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { initializeGrowthTables, createGrowthRouter } from './growthRoutes.js';

test('Reliv Growth & Cloud App Services Test Suite', async (t) => {
    let db;
    let app;
    let server;
    let baseUrl;

    t.before(async () => {
        db = new Database(':memory:');
        initializeGrowthTables(db);

        app = express();
        app.use(express.json());
        app.use(createGrowthRouter({ getDb: () => db }));

        // Also stub send-health-card and support-issue matching payment-bridge-service
        app.post('/api/send-health-card', (req, res) => {
            const { to, cardImage } = req.body || {};
            if (!to || !cardImage) {
                return res.status(400).json({ ok: false, error: 'Missing parameters' });
            }
            return res.json({ ok: true, sent: false, queued: true, message: 'Queued for delivery' });
        });

        app.post('/api/support-issue', (req, res) => {
            const { issue, page } = req.body || {};
            if (!issue && !page) {
                return res.status(400).json({ ok: false, error: 'Missing parameters' });
            }
            return res.json({ ok: true, caseId: 'HELP-12345', status: 'OPEN' });
        });

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port;
                baseUrl = `http://127.0.0.1:${port}`;
                resolve();
            });
        });
    });

    t.after(() => {
        if (server) server.close();
        if (db) db.close();
    });

    await t.test('1. Create referral code for new user', async () => {
        const res = await fetch(`${baseUrl}/api/growth/referral/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'RLV-TEST-001', publicAlias: 'Health Pioneer' })
        });
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.ok(data.referralCode.startsWith('RLV-'));
        assert.equal(data.userId, 'RLV-TEST-001');
    });

    await t.test('2. Anti-cheat: Block self-referrals', async () => {
        // Register referrer
        const refRes = await fetch(`${baseUrl}/api/growth/referral/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'RLV-SELF-01', customCode: 'RLV-SELF01' })
        });
        const refData = await refRes.json();

        // Try self-referral
        const claimRes = await fetch(`${baseUrl}/api/growth/referral/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                referralCode: refData.referralCode,
                refereeUserId: 'RLV-SELF-01',
                deviceSig: 'dev-sig-self'
            })
        });
        const claimData = await claimRes.json();
        assert.equal(claimRes.status, 400);
        assert.equal(claimData.ok, false);
        assert.equal(claimData.reason, 'SELF_REFERRAL_DISALLOWED');
    });

    await t.test('3. Anti-cheat: One Device Only One App policy blocks duplicate device claims', async () => {
        // Device A claims referral
        const claim1 = await fetch(`${baseUrl}/api/growth/referral/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                referralCode: 'RLV-SELF01',
                refereeUserId: 'RLV-FRIEND-01',
                deviceSig: 'hw-device-xyz'
            })
        });
        const data1 = await claim1.json();
        assert.equal(data1.ok, true);
        assert.equal(data1.claimed, true);

        // Same device tries to claim again under different user
        const claim2 = await fetch(`${baseUrl}/api/growth/referral/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                referralCode: 'RLV-SELF01',
                refereeUserId: 'RLV-FRAUD-02',
                deviceSig: 'hw-device-xyz'
            })
        });
        const data2 = await claim2.json();
        assert.equal(data2.ok, true);
        assert.equal(data2.ignored, true);
        assert.ok(['DEVICE_ALREADY_REGISTERED', 'REFERRAL_ALREADY_CLAIMED_ON_DEVICE'].includes(data2.reason));
    });

    await t.test('4. Leaderboard returns public aliases and member rankings', async () => {
        const res = await fetch(`${baseUrl}/api/growth/leaderboard`);
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.ok(Array.isArray(data.leaderboard));
        for (const entry of data.leaderboard) {
            assert.ok(entry.publicAlias || entry.name, 'Every entry must have a public alias or name');
            assert.ok(!entry.email, 'Email must NOT be leaked in public leaderboard');
        }
    });

    await t.test('5. Device binding enforces one device one user lock', async () => {
        const bindRes1 = await fetch(`${baseUrl}/api/growth/device-bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceSig: 'hw-unique-phone-1',
                userId: 'RLV-OWNER-01',
                platform: 'iOS'
            })
        });
        const bind1 = await bindRes1.json();
        assert.equal(bind1.ok, true);
        assert.equal(bind1.bound, true);

        // Different user tries to claim same device
        const bindRes2 = await fetch(`${baseUrl}/api/growth/device-bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceSig: 'hw-unique-phone-1',
                userId: 'RLV-IMPOSTOR-02',
                platform: 'Android'
            })
        });
        const bind2 = await bindRes2.json();
        assert.equal(bind2.ok, true);
        assert.equal(bind2.bound, false);
        assert.equal(bind2.reason, 'DEVICE_ALREADY_BOUND');
    });

    await t.test('6. Streak restore order creation & verification', async () => {
        const orderRes = await fetch(`${baseUrl}/api/streak/restore/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ streakDays: 7, amountPaise: 1500 })
        });
        const orderData = await orderRes.json();
        assert.equal(orderData.ok, true);
        assert.ok(orderData.order.id.startsWith('order_streak_'));

        const verifyRes = await fetch(`${baseUrl}/api/streak/restore/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                razorpay_payment_id: 'pay_test_123',
                razorpay_order_id: orderData.order.id,
                streakDays: 7
            })
        });
        const verifyData = await verifyRes.json();
        assert.equal(verifyData.ok, true);
        assert.equal(verifyData.verified, true);
    });

    await t.test('7. Store order queuing', async () => {
        const storeRes = await fetch(`${baseUrl}/api/store/order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product: 'Reliv Wellness Kit', quantity: 1 })
        });
        const storeData = await storeRes.json();
        assert.equal(storeData.ok, true);
        assert.equal(storeData.status, 'DISPATCH_QUEUED');
    });

    await t.test('8. Health card email delivery validation', async () => {
        const res = await fetch(`${baseUrl}/api/send-health-card`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                to: 'patient@example.com',
                name: 'Alice',
                cardImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            })
        });
        const data = await res.json();
        assert.equal(data.ok, true);
    });

    await t.test('9. Support ticket submission', async () => {
        const res = await fetch(`${baseUrl}/api/support-issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                page: 'CareHome',
                issue: 'Cannot sync scale reading'
            })
        });
        const data = await res.json();
        assert.equal(data.ok, true);
        assert.ok(data.caseId);
    });
});
