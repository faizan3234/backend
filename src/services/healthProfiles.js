import crypto from 'node:crypto';

const keyFor = name => typeof name === 'string'
    ? name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') : '';
const pinValid = pin => typeof pin === 'string' && /^\d{6}$/.test(pin);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const pinHash = (pin, salt) => crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');

export function attachHealthProfile(db, sessionManager, sessionId, input) {
    const name = typeof input.name === 'string' ? input.name.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    const nameKey = keyFor(name);
    const { pin, mode } = input;
    if (name.length < 2 || name.length > 80 || !pinValid(pin) || !['new', 'returning'].includes(mode)) {
        const error = new Error('Enter your name and a six-digit PIN.'); error.status = 400; throw error;
    }
    const current = sessionManager.getSession(sessionId);
    if (!current || !['CREATED', 'CUSTOMER_ATTACHED'].includes(current.status)) {
        const error = new Error('This kiosk session has expired. Please start again.'); error.status = 409; throw error;
    }
    const existing = db.prepare('SELECT profile_id, access_hash FROM health_profile_sessions WHERE session_id = ?').get(sessionId);
    if (existing) {
        const error = new Error('A profile is already connected to this session.'); error.status = 409; throw error;
    }
    const now = Date.now();
    const attempts = db.prepare('SELECT failed_count, locked_until FROM health_profile_attempts WHERE name_key = ?').get(nameKey);
    if (attempts?.locked_until > now) {
        const error = new Error('Too many attempts. Please wait 15 minutes.'); error.status = 429; throw error;
    }
    const candidates = db.prepare('SELECT * FROM health_profiles WHERE name_key = ?').all(nameKey);
    // Compare each candidate and never expose the candidate list to a caller.
    const matching = candidates.find(row => crypto.timingSafeEqual(
        Buffer.from(pinHash(pin, row.pin_salt), 'hex'), Buffer.from(row.pin_hash, 'hex')
    ));
    if (mode === 'returning' && !matching) {
        const failedCount = (attempts?.failed_count || 0) + 1;
        db.prepare(`INSERT INTO health_profile_attempts (name_key, failed_count, locked_until)
            VALUES (?, ?, ?) ON CONFLICT(name_key) DO UPDATE SET failed_count=excluded.failed_count, locked_until=excluded.locked_until`)
            .run(nameKey, failedCount >= 5 ? 0 : failedCount, failedCount >= 5 ? now + 15 * 60_000 : 0);
        const error = new Error('Name or PIN did not match. Please try again.'); error.status = 401; throw error;
    }
    if (mode === 'new' && matching) {
        const error = new Error('This name and PIN already belong to a profile. Choose Returning if it is yours.'); error.status = 409; throw error;
    }
    const age = mode === 'new' ? Number(input.age) : matching.age;
    const gender = mode === 'new' ? input.gender : matching.gender;
    if (!Number.isInteger(age) || age < 1 || age > 120 || !['male', 'female', 'other'].includes(gender)) {
        const error = new Error('Enter your age and select a gender.'); error.status = 400; throw error;
    }
    const email = mode === 'new' && typeof input.email === 'string' ? input.email.trim().toLowerCase() : (matching?.email || '');
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        const error = new Error('Enter a valid email or leave it blank.'); error.status = 400; throw error;
    }
    const accessToken = crypto.randomBytes(32).toString('hex');
    const customerData = { name: mode === 'new' ? name : matching.display_name, age, gender, email };
    db.transaction(() => {
        let profileId = matching?.profile_id;
        if (mode === 'new') {
            profileId = crypto.randomUUID();
            const salt = crypto.randomBytes(16).toString('hex');
            db.prepare(`INSERT INTO health_profiles (profile_id, name_key, display_name, pin_salt, pin_hash, age, gender, email)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(profileId, nameKey, name, salt, pinHash(pin, salt), age, gender, email);
        }
        sessionManager.attachCustomer(sessionId, customerData);
        db.prepare('INSERT INTO health_profile_sessions (session_id, profile_id, access_hash) VALUES (?, ?, ?)')
            .run(sessionId, profileId, digest(accessToken));
        db.prepare('DELETE FROM health_profile_attempts WHERE name_key = ?').run(nameKey);
    })();
    return { customerData, accessToken };
}

const METRICS = ['height', 'weight', 'systolic', 'diastolic', 'bpm', 'oxygen', 'temperature'];
export function privateHealthJourney(db, sessionId, accessToken) {
    if (typeof accessToken !== 'string' || !/^[a-f0-9]{64}$/.test(accessToken)) return null;
    const access = db.prepare('SELECT profile_id, access_hash FROM health_profile_sessions WHERE session_id = ?').get(sessionId);
    if (!access || !crypto.timingSafeEqual(Buffer.from(digest(accessToken), 'hex'), Buffer.from(access.access_hash, 'hex'))) return null;
    const current = db.prepare('SELECT rowid AS sequence FROM sessions WHERE session_id = ?').get(sessionId);
    if (!current) return null;
    const scans = db.prepare(`SELECT s.session_id, s.created_at, s.health_data, COUNT(*) OVER() AS scan_count FROM sessions s
        JOIN health_profile_sessions p ON p.session_id = s.session_id
        WHERE p.profile_id = ? AND s.rowid <= ? AND s.service_type = 'HEALTH_CHECKUP'
          AND s.payment_status = 'VERIFIED' AND s.report_status IN ('READY','EMAILED')
          AND s.health_data IS NOT NULL ORDER BY s.rowid DESC LIMIT 100`).all(access.profile_id, current.sequence);
    const history = [...scans].reverse().map(row => {
        let vitals;
        try { vitals = JSON.parse(row.health_data)?.vitals || {}; } catch { vitals = {}; }
        const point = { createdAt: row.created_at };
        for (const key of METRICS) {
            const value = Number(vitals[key]);
            if (vitals[key] !== null && vitals[key] !== undefined && vitals[key] !== '' && Number.isFinite(value) && value > 0) point[key] = value;
        }
        return point;
    });
    return { scanCount: scans[0]?.scan_count || 0, identityLinked: true, history };
}
