import { pbkdf2, randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(pbkdf2);
const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const matches = (a, b) => typeof a === 'string' && typeof b === 'string' &&
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function hashAdminPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = (await deriveKey(password, salt, 100000, 64, 'sha512')).toString('hex');
    return { algorithm: 'pbkdf2', salt, iterations: 100000, keyLen: 64, digest: 'sha512', hash };
}

// Opaque sessions are local to this backend process. Restarting the Pi requires
// admin login again; customer payment/session state remains untouched.
export function createAdminAuth({ loadCredentials, saveCredentials, loadResets, saveResets,
    queueReset, now = Date.now, bootstrapEmail = '', bootstrapPassword = '' }) {
    const sessions = new Map();
    const rateLimits = new Map();
    let mutation = Promise.resolve();
    const serial = (fn) => {
        const task = mutation.then(fn);
        mutation = task.catch(() => {});
        return task;
    };
    const configuredEmail = normalizeEmail(bootstrapEmail);
    let bootstrapRecord;
    async function account(email, store) {
        const key = Object.keys(store).find((item) => normalizeEmail(item) === email);
        if (key) return { key, record: store[key] };
        if (validEmail(configuredEmail) && email === configuredEmail && bootstrapPassword.length >= 12) {
            bootstrapRecord ||= hashAdminPassword(bootstrapPassword);
            return { key: email, record: await bootstrapRecord };
        }
        return null;
    }
    function limit(req, res, next) {
        const current = now();
        for (const [key, value] of rateLimits) if (value.until <= current) rateLimits.delete(key);
        const key = `${req.ip}:${req.path}`;
        if (!rateLimits.has(key) && rateLimits.size >= 2000) {
            return res.status(429).json({ ok: false, message: 'Please wait before trying again.' });
        }
        const record = rateLimits.get(key) || { count: 0, until: current + 15 * 60 * 1000 };
        record.count += 1;
        rateLimits.set(key, record);
        if (record.count > 10) {
            res.set('Retry-After', String(Math.ceil((record.until - current) / 1000)));
            return res.status(429).json({ ok: false, message: 'Too many attempts. Please try again later.' });
        }
        next();
    }
    function revoke(email) {
        for (const [key, value] of sessions) if (value.email === email) sessions.delete(key);
    }
    function requireAdmin(req, res, next) {
        const token = req.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const session = token && sessions.get(digest(token));
        if (!session || session.expiresAt <= now()) {
            if (token) sessions.delete(digest(token));
            return res.status(401).json({ ok: false, code: 'ADMIN_LOGIN_REQUIRED', message: 'Please sign in to the admin panel again.' });
        }
        req.admin = session;
        next();
    }
    function protectWrites(req, res, next) {
        const protectedPath = /^\/api\/(kits(?:\/|$)|inventory(?:\/|$)|report-price\/?$|speech-config\/?$|ads\/settings\/?$)/i.test(req.path);
        if (protectedPath && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return requireAdmin(req, res, next);
        next();
    }
    const wrap = (handler) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { await handler(req, res); }
        catch { res.status(503).json({ ok: false, message: 'Admin service unavailable. Please try again.' }); }
    };
    function register(app) {
        app.post('/api/check-login', limit, wrap((req, res) => serial(async () => {
            const email = normalizeEmail(req.body?.email);
            const password = req.body?.password;
            if (!validEmail(email) || typeof password !== 'string' || password.length > 1024) {
                return res.status(400).json({ ok: false, message: 'Enter your admin email and password.' });
            }
            const admin = await account(email, await loadCredentials());
            let verified = false;
            if (admin?.record?.salt && admin.record.hash) {
                const record = admin.record;
                const hash = (await deriveKey(password, record.salt, record.iterations || 100000,
                    record.keyLen || 64, record.digest || 'sha512')).toString('hex');
                verified = matches(hash, record.hash);
            }
            if (!verified) return res.status(401).json({ ok: false, message: 'Invalid admin email or password.' });
            for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
            if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
            const token = randomBytes(32).toString('hex');
            const expiresAt = now() + 8 * 60 * 60 * 1000;
            sessions.set(digest(token), { email, expiresAt });
            res.json({ ok: true, token, expiresAt });
        })));
        app.post('/api/admin/logout', requireAdmin, (req, res) => {
            sessions.delete(digest(req.get('Authorization').slice(7)));
            res.json({ ok: true });
        });
        app.post('/api/send-reset-email', limit, wrap((req, res) => serial(async () => {
            const email = normalizeEmail(req.body?.to);
            const response = { ok: true, message: 'If this admin account exists, a recovery email has been queued.' };
            const admin = validEmail(email) && await account(email, await loadCredentials());
            if (!admin) return res.json(response);
            const token = String(randomInt(100000, 1000000));
            const expiry = now() + 15 * 60 * 1000;
            const store = await loadResets();
            store[email] = { tokenHash: digest(token), expiry, attempts: 0 };
            await saveResets(store);
            await queueReset(email, token, expiry);
            res.json(response);
        })));
        app.post('/api/confirm-reset', limit, wrap((req, res) => serial(async () => {
            const email = normalizeEmail(req.body?.email);
            const { token, newPassword } = req.body || {};
            if (!validEmail(email) || typeof token !== 'string' || !/^\d{6}$/.test(token) ||
                typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 1024) {
                return res.status(400).json({ ok: false, message: 'Enter a valid recovery code and a password of at least 12 characters.' });
            }
            const store = await loadResets();
            const entry = store[email];
            const credentials = await loadCredentials();
            const admin = await account(email, credentials);
            if (!admin || !entry || entry.expiry <= now() || (entry.attempts || 0) >= 5) {
                return res.status(400).json({ ok: false, message: 'Invalid or expired recovery code.' });
            }
            if (!matches(digest(token), entry.tokenHash)) {
                entry.attempts = (entry.attempts || 0) + 1;
                await saveResets(store);
                return res.status(400).json({ ok: false, message: 'Invalid or expired recovery code.' });
            }
            // Consume before changing the password: a persistence failure must
            // not leave a reusable recovery code after a successful reset.
            delete store[email];
            await saveResets(store);
            credentials[admin.key] = { ...await hashAdminPassword(newPassword), updatedAt: now() };
            await saveCredentials(credentials);
            revoke(email);
            res.json({ ok: true });
        })));
    }
    return { register, protectWrites, requireAdmin };
}
