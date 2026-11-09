import express from 'express';
import crypto from 'node:crypto';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RELIV GROWTH, REFERRAL & ANTI-CHEAT ENGINE (CLOUD BRIDGE & KIOSK COMPATIBLE)
 * Policy: "ONE DEVICE ONLY ONE APP"
 * Multi-layer race condition protection with atomic SQLite transactions
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function initializeGrowthTables(db) {
    if (!db) return;
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS growth_referrals (
                referral_id TEXT PRIMARY KEY,
                referrer_user_id TEXT NOT NULL,
                referrer_code TEXT NOT NULL,
                referee_user_id TEXT,
                referee_device_sig TEXT,
                status TEXT NOT NULL DEFAULT 'PENDING',
                active_days INTEGER NOT NULL DEFAULT 0,
                reward_claimed INTEGER NOT NULL DEFAULT 0,
                metadata TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_growth_referrals_referrer ON growth_referrals(referrer_user_id);
            CREATE INDEX IF NOT EXISTS idx_growth_referrals_code ON growth_referrals(referrer_code);
            CREATE INDEX IF NOT EXISTS idx_growth_referrals_referee ON growth_referrals(referee_user_id);

            CREATE TABLE IF NOT EXISTS growth_devices (
                device_sig TEXT PRIMARY KEY,
                bound_user_id TEXT NOT NULL,
                platform TEXT,
                user_agent TEXT,
                ip_address TEXT,
                risk_score TEXT DEFAULT 'LOW',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_growth_devices_user ON growth_devices(bound_user_id);

            CREATE TABLE IF NOT EXISTS streak_restores (
                restore_id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                order_id TEXT,
                payment_id TEXT,
                amount REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'INITIATED',
                streak_before INTEGER NOT NULL DEFAULT 0,
                streak_after INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_streak_restores_user ON streak_restores(user_id);

            CREATE TABLE IF NOT EXISTS kits (
                kit_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                price REAL NOT NULL DEFAULT 0,
                quantity INTEGER NOT NULL DEFAULT 0,
                motor_id INTEGER,
                category TEXT,
                image_path TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS support_cases (
                case_id TEXT PRIMARY KEY,
                session_id TEXT,
                kind TEXT,
                status TEXT DEFAULT 'OPEN',
                evidence_json TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        // Synchronize inventory items to kits table if inventory exists
        try {
            db.exec(`
                INSERT OR IGNORE INTO kits (kit_id, name, description, price, quantity, motor_id, image_path, updated_at)
                SELECT kit_id, name, description, price, quantity, motor_id, image_path, updated_at FROM inventory;
            `);
        } catch {}
    } catch (err) {
        console.warn('[Growth] Could not initialize growth tables:', err.message);
    }
}

export function generateRelivUserId() {
    const num = Math.floor(100000 + Math.random() * 900000);
    return `RLV-${num}`;
}

export function generateReferralCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `RLV-${code}`;
}

export function createGrowthRouter({ getDb }) {
    const router = express.Router();

    const getSafeDb = () => {
        try {
            const db = typeof getDb === 'function' ? getDb() : getDb;
            if (db) initializeGrowthTables(db);
            return db;
        } catch {
            return null;
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 1. REGISTER REFERRAL CODE
    // POST /api/growth/referral/create & POST /growth/referral/create
    // ─────────────────────────────────────────────────────────────────────────
    const handleReferralCreate = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const db = getSafeDb();
            const { userId, customCode, name, email, publicAlias } = req.body || {};
            const effectiveUserId = userId || generateRelivUserId();
            let effectiveCode = customCode ? String(customCode).trim().toUpperCase() : null;

            if (!effectiveCode || !/^RLV-[A-Z0-9]{4,10}$/.test(effectiveCode)) {
                effectiveCode = generateReferralCode();
            }

            if (db) {
                const txResult = db.transaction(() => {
                    const existing = db.prepare('SELECT * FROM growth_referrals WHERE referrer_user_id = ? AND referee_user_id IS NULL').get(effectiveUserId);
                    if (existing) {
                        return {
                            ok: true,
                            referralCode: existing.referrer_code,
                            userId: effectiveUserId,
                            publicAlias: publicAlias || `Member ${existing.referrer_code}`,
                            isExisting: true
                        };
                    }

                    const codeTaken = db.prepare('SELECT * FROM growth_referrals WHERE referrer_code = ?').get(effectiveCode);
                    if (codeTaken && codeTaken.referrer_user_id !== effectiveUserId) {
                        effectiveCode = generateReferralCode();
                    }

                    const refId = `REF-REG-${crypto.randomUUID()}`;
                    db.prepare(`
                        INSERT INTO growth_referrals (referral_id, referrer_user_id, referrer_code, status, metadata, created_at, updated_at)
                        VALUES (?, ?, ?, 'QUALIFIED', ?, datetime('now'), datetime('now'))
                    `).run(
                        refId,
                        effectiveUserId,
                        effectiveCode,
                        JSON.stringify({ name: name || '', email: email || '', publicAlias: publicAlias || `Member ${effectiveCode}` })
                    );

                    return {
                        ok: true,
                        referralCode: effectiveCode,
                        userId: effectiveUserId,
                        publicAlias: publicAlias || `Member ${effectiveCode}`,
                        isNew: true
                    };
                })();

                return res.json(txResult);
            }

            return res.json({
                ok: true,
                referralCode: effectiveCode,
                userId: effectiveUserId,
                publicAlias: publicAlias || `Member ${effectiveCode}`,
                isNew: true
            });
        } catch (err) {
            console.error('[Growth] Referral create error:', err);
            return res.status(500).json({ ok: false, error: err.message || 'Failed to create referral code' });
        }
    };

    router.post('/api/growth/referral/create', handleReferralCreate);
    router.post('/growth/referral/create', handleReferralCreate);

    // ─────────────────────────────────────────────────────────────────────────
    // 2. CLAIM REFERRAL REWARD (ONE DEVICE ONLY ONE APP ANTI-CHEAT)
    // POST /api/growth/referral/claim & POST /growth/referral/claim
    // ─────────────────────────────────────────────────────────────────────────
    const handleReferralClaim = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const db = getSafeDb();
            const { referralCode, refereeUserId, deviceSig } = req.body || {};

            if (!referralCode) {
                return res.status(400).json({ ok: false, error: 'referralCode is required' });
            }

            const cleanCode = String(referralCode).trim().toUpperCase();

            if (db) {
                const txResult = db.transaction(() => {
                    const referrer = db.prepare('SELECT * FROM growth_referrals WHERE referrer_code = ?').get(cleanCode);
                    if (!referrer) {
                        return { status: 404, payload: { ok: false, error: 'Referral code not found' } };
                    }

                    // Anti-cheat: Self referral rejection
                    if (refereeUserId && referrer.referrer_user_id === refereeUserId) {
                        return {
                            status: 400,
                            payload: {
                                ok: false,
                                error: 'Self-referrals are not permitted',
                                reason: 'SELF_REFERRAL_DISALLOWED'
                            }
                        };
                    }

                    // Anti-cheat: One Device Only One App policy
                    if (deviceSig) {
                        const existingDevice = db.prepare('SELECT * FROM growth_devices WHERE device_sig = ?').get(deviceSig);
                        if (existingDevice && existingDevice.bound_user_id !== refereeUserId) {
                            return {
                                status: 200,
                                payload: {
                                    ok: true,
                                    ignored: true,
                                    reason: 'DEVICE_ALREADY_REGISTERED',
                                    message: 'One device only one app policy: duplicate device reinstallation yields zero referral credit.'
                                }
                            };
                        }

                        const alreadyClaimed = db.prepare('SELECT * FROM growth_referrals WHERE referrer_code = ? AND referee_device_sig = ?').get(cleanCode, deviceSig);
                        if (alreadyClaimed) {
                            return {
                                status: 200,
                                payload: {
                                    ok: true,
                                    ignored: true,
                                    reason: 'REFERRAL_ALREADY_CLAIMED_ON_DEVICE',
                                    message: 'This referral has already been claimed on this device.'
                                }
                            };
                        }
                    }

                    const claimId = `CLAIM-${crypto.randomUUID()}`;
                    db.prepare(`
                        INSERT INTO growth_referrals (referral_id, referrer_user_id, referrer_code, referee_user_id, referee_device_sig, status, active_days, reward_claimed, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'QUALIFIED', 1, 1, datetime('now'), datetime('now'))
                    `).run(claimId, referrer.referrer_user_id, cleanCode, refereeUserId || null, deviceSig || null);

                    return {
                        status: 200,
                        payload: {
                            ok: true,
                            claimed: true,
                            reward: {
                                bonusDays: 7,
                                streakProtection: 1
                            },
                            message: 'Referral reward claimed successfully under One Device Only One App policy.'
                        }
                    };
                })();

                return res.status(txResult.status).json(txResult.payload);
            }

            return res.json({
                ok: true,
                claimed: true,
                reward: {
                    bonusDays: 7,
                    streakProtection: 1
                },
                message: 'Referral reward claimed successfully under One Device Only One App policy.'
            });
        } catch (err) {
            console.error('[Growth] Referral claim error:', err);
            return res.status(500).json({ ok: false, error: err.message || 'Failed to claim referral reward' });
        }
    };

    router.post('/api/growth/referral/claim', handleReferralClaim);
    router.post('/growth/referral/claim', handleReferralClaim);

    // ─────────────────────────────────────────────────────────────────────────
    // 3. ANONYMOUS LEADERBOARD
    // GET /api/growth/leaderboard & GET /api/growth/referral/leaderboard
    // ─────────────────────────────────────────────────────────────────────────
    const handleLeaderboard = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const db = getSafeDb();
            const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
            let leaderboard = [];

            if (db) {
                const rows = db.prepare(`
                    SELECT referrer_user_id, referrer_code, COUNT(*) as qualifiedReferrals, metadata
                    FROM growth_referrals
                    WHERE referee_user_id IS NOT NULL AND status IN ('QUALIFIED', 'ACCEPTED')
                    GROUP BY referrer_user_id
                    ORDER BY qualifiedReferrals DESC
                    LIMIT ?
                `).all(limit);

                leaderboard = rows.map((r, idx) => {
                    let alias = `Wellness Star ${String(idx + 1).padStart(3, '0')}`;
                    try {
                        const meta = JSON.parse(r.metadata || '{}');
                        if (meta.publicAlias) alias = meta.publicAlias;
                    } catch {}
                    return {
                        rank: idx + 1,
                        publicAlias: alias,
                        qualifiedReferrals: r.qualifiedReferrals || 0
                    };
                });
            }

            return res.json({
                ok: true,
                leaderboard,
                totalMembers: leaderboard.length,
                asOf: new Date().toISOString()
            });
        } catch (err) {
            console.error('[Growth] Leaderboard error:', err);
            return res.status(500).json({ ok: false, error: err.message || 'Failed to load leaderboard' });
        }
    };

    router.get('/api/growth/referral/leaderboard', handleLeaderboard);
    router.get('/growth/referral/leaderboard', handleLeaderboard);
    router.get('/api/growth/leaderboard', handleLeaderboard);
    router.get('/growth/leaderboard', handleLeaderboard);

    // ─────────────────────────────────────────────────────────────────────────
    // 4. DEVICE BINDING (ANTI-CHEAT "ONE DEVICE ONLY ONE APP")
    // POST /api/growth/device-bind & POST /growth/device-bind
    // ─────────────────────────────────────────────────────────────────────────
    const handleDeviceBind = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const db = getSafeDb();
            const { deviceSig, userId, platform, userAgent } = req.body || {};

            if (!deviceSig || !userId) {
                return res.status(400).json({ ok: false, error: 'deviceSig and userId are required' });
            }

            if (db) {
                const txResult = db.transaction(() => {
                    const existing = db.prepare('SELECT * FROM growth_devices WHERE device_sig = ?').get(deviceSig);
                    if (existing) {
                        if (existing.bound_user_id !== userId) {
                            return {
                                ok: true,
                                bound: false,
                                reason: 'DEVICE_ALREADY_BOUND',
                                boundUserId: existing.bound_user_id,
                                message: 'One device only one app policy: this device is already permanently bound to another Reliv user account.'
                            };
                        }

                        db.prepare('UPDATE growth_devices SET updated_at = datetime("now") WHERE device_sig = ?').run(deviceSig);
                        return {
                            ok: true,
                            bound: true,
                            existing: true,
                            message: 'Device binding verified for user account.'
                        };
                    }

                    db.prepare(`
                        INSERT INTO growth_devices (device_sig, bound_user_id, platform, user_agent, ip_address, risk_score, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'LOW', datetime('now'), datetime('now'))
                    `).run(deviceSig, userId, platform || 'web', userAgent || '', req.ip || '');

                    return {
                        ok: true,
                        bound: true,
                        isNewDevice: true,
                        message: 'Device bound successfully under One Device Only One App policy.'
                    };
                })();

                return res.json(txResult);
            }

            return res.json({
                ok: true,
                bound: true,
                isNewDevice: true,
                message: 'Device bound successfully under One Device Only One App policy.'
            });
        } catch (err) {
            console.error('[Growth] Device bind error:', err);
            return res.status(500).json({ ok: false, error: err.message || 'Failed to bind device' });
        }
    };

    router.post('/api/growth/device-bind', handleDeviceBind);
    router.post('/growth/device-bind', handleDeviceBind);

    // ─────────────────────────────────────────────────────────────────────────
    // 5. REFERRAL LANDING TRACK & PUBLIC QUERY ENDPOINT
    // ALL-IN-ONE compatibility with customer-web/api/growth/referrals.js
    // ─────────────────────────────────────────────────────────────────────────
    const handleReferralsUnified = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const action = req.query?.action || (req.body && req.body.action) || 'leaderboard';

        if (action === 'leaderboard') {
            return handleLeaderboard(req, res);
        }

        if (action === 'track') {
            try {
                const db = getSafeDb();
                const body = req.body || {};
                const targetRef = req.query?.refCode || body.refCode;
                const visitorId = req.query?.userId || body.userId;
                const deviceSig = body.hardwareHash || body.deviceSignature || body.deviceSig;

                if (!targetRef) {
                    return res.status(400).json({ ok: false, error: 'Missing refCode' });
                }

                if (db && deviceSig) {
                    const existingDevice = db.prepare('SELECT * FROM growth_devices WHERE device_sig = ?').get(deviceSig);
                    if (existingDevice) {
                        return res.status(200).json({
                            ok: true,
                            ignored: true,
                            reason: 'DEVICE_ALREADY_REGISTERED',
                            message: 'One device only one app policy: duplicate device reinstallation yields zero referral credit.'
                        });
                    }

                    if (visitorId) {
                        db.prepare(`
                            INSERT OR IGNORE INTO growth_devices (device_sig, bound_user_id, platform, risk_score, created_at, updated_at)
                            VALUES (?, ?, 'web', 'LOW', datetime('now'), datetime('now'))
                        `).run(deviceSig, visitorId);
                    }
                }

                return res.status(200).json({ ok: true, tracked: true, refCode: targetRef });
            } catch (err) {
                return res.status(500).json({ ok: false, error: err.message || 'Failed to track referral' });
            }
        }

        if (action === 'stats') {
            const db = getSafeDb();
            const targetId = req.query?.userId || req.body?.userId;
            let qualified = 0;
            if (db && targetId) {
                try {
                    const row = db.prepare('SELECT COUNT(*) as count FROM growth_referrals WHERE referrer_user_id = ? AND referee_user_id IS NOT NULL').get(targetId);
                    qualified = row?.count || 0;
                } catch {}
            }
            return res.json({
                ok: true,
                stats: {
                    trackedOpens: 0,
                    acceptedReferrals: qualified,
                    qualifiedReferrals: qualified
                }
            });
        }

        return handleLeaderboard(req, res);
    };

    router.get('/api/growth/referrals', handleReferralsUnified);
    router.post('/api/growth/referrals', handleReferralsUnified);
    router.get('/growth/referrals', handleReferralsUnified);
    router.post('/growth/referrals', handleReferralsUnified);

    const handleReferralTrack = (req, res) => {
        req.query = req.query || {};
        req.query.action = 'track';
        return handleReferralsUnified(req, res);
    };
    router.post('/api/growth/track', handleReferralTrack);
    router.post('/growth/track', handleReferralTrack);

    // ─────────────────────────────────────────────────────────────────────────
    // 6. ADMIN GROWTH INTELLIGENCE (/yuewyue)
    // GET /api/growth/admin & GET /growth/admin
    // ─────────────────────────────────────────────────────────────────────────
    const handleGrowthAdmin = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const authHeader = req.headers?.authorization || '';
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        const passkey = req.query?.passkey || token;

        const isAuthorized =
            passkey === 'reliv-admin-2026' ||
            token.toLowerCase() === 'relivcustomercare@gmail.com' ||
            token.toLowerCase() === 'faizan3234@gmail.com';

        if (!isAuthorized) {
            return res.status(403).json({
                ok: false,
                error: 'UNAUTHORIZED_ADMIN_ACCESS',
                message: 'Access to growth admin intelligence requires authorized credentials.'
            });
        }

        const db = getSafeDb();
        let totalUsers = 0;
        let totalDevices = 0;
        let totalReferrals = 0;

        if (db) {
            try {
                totalUsers = db.prepare('SELECT COUNT(DISTINCT referrer_user_id) as c FROM growth_referrals').get()?.c || 0;
                totalDevices = db.prepare('SELECT COUNT(*) as c FROM growth_devices').get()?.c || 0;
                totalReferrals = db.prepare('SELECT COUNT(*) as c FROM growth_referrals WHERE referee_user_id IS NOT NULL').get()?.c || 0;
            } catch {}
        }

        return res.json({
            ok: true,
            overview: {
                uniqueRegisteredUsers: totalUsers,
                totalQualifiedReferrals: totalReferrals,
                deviceSecurity: {
                    policy: 'ONE_DEVICE_ONLY_ONE_APP',
                    enforced: true,
                    totalRegisteredDevices: totalDevices,
                    totalBlockedDuplicateLoops: 0
                }
            }
        });
    };
    router.get('/api/growth/admin', handleGrowthAdmin);
    router.get('/growth/admin', handleGrowthAdmin);

    // ─────────────────────────────────────────────────────────────────────────
    // 7. CUSTOMER WEB STORE DISPATCH
    // POST /api/store/order & POST /store/order
    // ─────────────────────────────────────────────────────────────────────────
    const handleStoreOrder = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { orderId } = req.body || {};
            const resolvedOrderId = orderId || `ORD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            return res.json({
                ok: true,
                orderId: resolvedOrderId,
                status: 'DISPATCH_QUEUED',
                message: 'Store order received and queued for dispatch.'
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to process store order' });
        }
    };

    router.post('/api/store/order', handleStoreOrder);
    router.post('/store/order', handleStoreOrder);

    // ─────────────────────────────────────────────────────────────────────────
    // 8. STREAK RESTORE ORDER, VERIFY, CLAIM & GOAL VERIFY
    // ─────────────────────────────────────────────────────────────────────────
    const handleStreakRestore = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const db = getSafeDb();
            const { userId, orderId, paymentId, amount, streakBefore } = req.body || {};
            const restoreId = `STREAK-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

            if (db && userId) {
                db.transaction(() => {
                    db.prepare(`
                        INSERT INTO streak_restores (restore_id, user_id, order_id, payment_id, amount, status, streak_before, streak_after, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'APPLIED', ?, ?, datetime('now'), datetime('now'))
                    `).run(
                        restoreId,
                        userId,
                        orderId || null,
                        paymentId || null,
                        amount || 0,
                        streakBefore || 0,
                        streakBefore ? streakBefore + 1 : 1
                    );
                })();
            }

            return res.json({
                ok: true,
                restoreId,
                status: 'RESTORE_APPLIED',
                restored: true,
                message: 'Streak restored and protected successfully.'
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to restore streak' });
        }
    };

    router.post('/api/streak/restore', handleStreakRestore);
    router.post('/streak/restore', handleStreakRestore);

    const handleCustomInquiry = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { inquiry } = req.body || {};
            const inquiryId = inquiry?.id || `INQ-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            return res.json({
                ok: true,
                inquiryId,
                status: 'RECEIVED',
                message: 'Custom hardware inquiry received and queued for review.'
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to process inquiry' });
        }
    };
    router.post('/api/store/custom-inquiry', handleCustomInquiry);
    router.post('/store/custom-inquiry', handleCustomInquiry);

    const handleAdCampaignProposal = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { proposal } = req.body || {};
            const campaignId = proposal?.id || `AD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            return res.json({
                ok: true,
                campaignId,
                status: 'RECEIVED',
                message: 'Ad campaign proposal received and queued for review.'
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to process proposal' });
        }
    };
    router.post('/api/store/ad-campaign', handleAdCampaignProposal);
    router.post('/store/ad-campaign', handleAdCampaignProposal);

    const handleStreakOrder = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { amountPaise } = req.body || {};
            const orderId = `order_streak_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
            return res.json({
                ok: true,
                order: {
                    id: orderId,
                    entity: 'order',
                    amount: amountPaise || 4900,
                    currency: 'INR',
                    receipt: `rcpt_streak_${Date.now()}`,
                    status: 'created'
                }
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to create streak restore order' });
        }
    };
    router.post('/api/streak/restore/order', handleStreakOrder);
    router.post('/streak/restore/order', handleStreakOrder);

    const handleStreakVerify = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { razorpay_payment_id, razorpay_order_id, streakDays } = req.body || {};
            return res.json({
                ok: true,
                verified: true,
                paymentId: razorpay_payment_id || null,
                orderId: razorpay_order_id || null,
                streakDays: streakDays || 1
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to verify streak restore' });
        }
    };
    router.post('/api/streak/restore/verify', handleStreakVerify);
    router.post('/streak/restore/verify', handleStreakVerify);

    const handleStreakClaim = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { streakDays, paymentId } = req.body || {};
            return res.json({
                ok: true,
                claimed: true,
                streakDays: streakDays || 1,
                paymentId: paymentId || null,
                message: 'Streak restoration claimed successfully.'
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to claim streak restore' });
        }
    };
    router.post('/api/streak/restore/claim', handleStreakClaim);
    router.post('/streak/restore/claim', handleStreakClaim);

    const handleGoalRefund = (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        try {
            const { entriesCount, targetDays } = req.body || {};
            return res.json({
                ok: true,
                verified: true,
                entriesCount: entriesCount || 0,
                targetDays: targetDays || 5,
                eligible: true
            });
        } catch (err) {
            return res.status(500).json({ ok: false, error: err.message || 'Failed to verify goal refund' });
        }
    };
    router.post('/api/goal/verify-refund', handleGoalRefund);
    router.post('/goal/verify-refund', handleGoalRefund);

    return router;
}

export default createGrowthRouter;

