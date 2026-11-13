import { randomBytes, randomUUID } from 'node:crypto';
import { digest, growthError } from './growthIdentity.js';

const DAY = 86400000;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const normalizeReferralCode = value => {
  if (typeof value !== 'string') return '';
  const code = value.trim().replace(/\s/g, '').toUpperCase();
  return code.startsWith('RLV-') ? code : `RLV-${code}`;
};
const text = (value, max = 60) => typeof value === 'string' ? value.trim().replace(/[\x00-\x1f<>]/g, '').slice(0, max) : '';
const dayKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const validCode = code => /^RLV-[0-9A-HJKMNP-TV-Z]{5}$/.test(code);
const publicName = row => row.name || `Member ${row.id}`;

export class GrowthService {
  constructor({ db, clock = Date.now }) {
    this.db = db; this.clock = clock;
    // The previous unauthenticated endpoint used this name for a different
    // schema. Keep its records for staff review, never promote client-supplied
    // identity/score claims into the verified ledger or drop the old data.
    const legacyColumns = db.prepare('PRAGMA table_info(growth_referrals)').all();
    if (legacyColumns.some(column => column.name === 'referral_id')) {
      db.transaction(() => {
        db.exec('ALTER TABLE growth_referrals RENAME TO growth_referrals_legacy_v1');
      })();
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS growth_members (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, registration_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '', email TEXT, phone TEXT NOT NULL DEFAULT '', google_sub TEXT UNIQUE,
        created_at INTEGER NOT NULL, decision TEXT NOT NULL DEFAULT 'PENDING'
      );
      CREATE TABLE IF NOT EXISTS growth_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES growth_members(id), expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS growth_registration_links (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES growth_members(id));
      CREATE TABLE IF NOT EXISTS growth_referrals (
        invitee TEXT PRIMARY KEY REFERENCES growth_members(id), inviter TEXT NOT NULL REFERENCES growth_members(id),
        accepted_at INTEGER NOT NULL, qualified_at INTEGER, CHECK(invitee != inviter)
      );
      CREATE INDEX IF NOT EXISTS growth_referral_inviter ON growth_referrals(inviter);
      CREATE TABLE IF NOT EXISTS growth_days (user_id TEXT NOT NULL REFERENCES growth_members(id), day TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id,day));
      CREATE TABLE IF NOT EXISTS growth_signals (user_id TEXT NOT NULL REFERENCES growth_members(id), type TEXT NOT NULL, day TEXT NOT NULL, platform TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id,type,day));
      CREATE INDEX IF NOT EXISTS growth_signal_activity ON growth_signals(type,at,user_id);
      CREATE INDEX IF NOT EXISTS growth_signal_day ON growth_signals(user_id,type,day);
      CREATE INDEX IF NOT EXISTS growth_member_created ON growth_members(created_at);
      CREATE TABLE IF NOT EXISTS growth_opens (inviter TEXT NOT NULL REFERENCES growth_members(id), visitor TEXT NOT NULL REFERENCES growth_members(id), at INTEGER NOT NULL, PRIMARY KEY(inviter,visitor));
      CREATE TABLE IF NOT EXISTS growth_rewards (user_id TEXT PRIMARY KEY REFERENCES growth_members(id), grant_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS growth_audit (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, actor TEXT, detail TEXT, at INTEGER NOT NULL);
    `);
  }
  audit(userId, action, actor = null, detail = '') {
    this.db.prepare('INSERT INTO growth_audit(user_id,action,actor,detail,at) VALUES(?,?,?,?,?)').run(userId, action, actor, text(detail, 300), this.clock());
  }
  register(registrationKey) {
    if (typeof registrationKey !== 'string' || !/^[a-f0-9]{64}$/.test(registrationKey)) throw growthError(400, 'A secure browser registration key is required.');
    const registrationHash = digest(registrationKey);
    return this.db.transaction(() => {
      let member = this.db.prepare('SELECT m.* FROM growth_registration_links l JOIN growth_members m ON m.id=l.user_id WHERE l.hash=?').get(registrationHash)
        || this.db.prepare('SELECT * FROM growth_members WHERE registration_hash=?').get(registrationHash);
      if (!member) {
        let code;
        do { code = 'RLV-' + [...randomBytes(5)].map(b => alphabet[b % 32]).join(''); }
        while (this.db.prepare('SELECT 1 FROM growth_members WHERE code=?').get(code));
        const id = `RLV-${randomUUID()}`;
        this.db.prepare('INSERT INTO growth_members(id,code,registration_hash,created_at) VALUES(?,?,?,?)').run(id, code, registrationHash, this.clock());
        member = this.db.prepare('SELECT * FROM growth_members WHERE id=?').get(id);
      }
      const token = randomBytes(32).toString('hex');
      this.db.prepare('DELETE FROM growth_sessions WHERE expires_at < ?').run(this.clock());
      this.db.prepare('INSERT INTO growth_sessions VALUES(?,?,?)').run(digest(token), member.id, this.clock() + 90 * DAY);
      return { ok: true, token, ...this.snapshot(member.id) };
    })();
  }
  authenticate(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw growthError(401, 'Connect to the referral service again.');
    const member = this.db.prepare('SELECT m.* FROM growth_sessions s JOIN growth_members m ON m.id=s.user_id WHERE s.hash=? AND s.expires_at>?').get(digest(token), this.clock());
    if (!member) throw growthError(401, 'Your referral session expired. Connect again.');
    return member;
  }
  member(code) {
    code = normalizeReferralCode(code);
    if (!validCode(code)) throw growthError(400, 'Enter a code such as RLV-K7P42.');
    const row = this.db.prepare("SELECT * FROM growth_members WHERE code=? AND decision!='DISQUALIFIED'").get(code);
    if (!row) throw growthError(404, 'This referral code is not registered. Ask your friend to open Reliv and share their current code.');
    return row;
  }
  claim(user, code) {
    try {
    const referrer = this.member(code);
    if (user.decision === 'DISQUALIFIED') throw growthError(403, 'This account is not eligible for referral rewards.');
    if (referrer.id === user.id) { this.audit(user.id, 'SELF_REFERRAL_BLOCKED'); throw growthError(409, 'You cannot use your own referral code.'); }
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM growth_referrals WHERE invitee=?').get(user.id);
      if (prior && prior.inviter !== referrer.id) throw growthError(409, 'Your account is already linked to a friend.');
      // Do not permit referral loops, including indirect A -> B -> C -> A loops.
      const ancestors = this.db.prepare(`WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT r.inviter FROM growth_referrals r JOIN chain c ON r.invitee=c.id) SELECT id FROM chain`).all(referrer.id);
      if (ancestors.some(a => a.id === user.id)) throw growthError(409, 'This referral would create a referral loop.');
      if (!prior) {
        this.db.prepare('INSERT INTO growth_referrals(invitee,inviter,accepted_at) VALUES(?,?,?)').run(user.id, referrer.id, this.clock());
        this.db.prepare('INSERT OR IGNORE INTO growth_rewards VALUES(?,?,?)').run(user.id, randomUUID(), this.clock());
        this.audit(user.id, 'REFERRAL_ACCEPTED', null, referrer.id);
      } else this.audit(user.id, 'REFERRAL_REPLAY_IGNORED', null, referrer.id);
      return { ok: true, alreadyAccepted: !!prior, ...this.snapshot(user.id) };
    })();
    } catch (error) {
      // Record rejected attempts after the transaction rolls back. Otherwise the
      // fraud evidence would be rolled back along with the rejected claim.
      if (error.status >= 400 && error.status < 500) this.audit(user.id, 'REFERRAL_REJECTED', null, error.message);
      throw error;
    }
  }
  profile(user, body) {
    const name = text(body.name), phone = text(body.phone, 25);
    if (phone && !/^\+?[\d ()-]{6,25}$/.test(phone)) throw growthError(400, 'Check your contact number.');
    this.db.prepare('UPDATE growth_members SET name=?,phone=? WHERE id=?').run(name, phone, user.id);
    return { ok: true, ...this.snapshot(user.id) };
  }
  linkGoogle(user, verified, token) {
    return this.db.transaction(() => {
      if (user.google_sub && user.google_sub !== verified.sub) throw growthError(409, 'This Reliv account already belongs to another Google account.');
      const previous = this.db.prepare('SELECT * FROM growth_members WHERE google_sub=?').get(verified.sub);
      if (previous && previous.id !== user.id) {
        // Reinstall / second browser: recover the original member. Never transfer
        // unverified referral credits or allow another welcome grant.
        this.db.prepare("UPDATE growth_members SET decision='DISQUALIFIED' WHERE id=?").run(user.id);
        this.db.prepare('UPDATE growth_sessions SET user_id=? WHERE hash=?').run(previous.id, digest(token));
        this.db.prepare('INSERT OR REPLACE INTO growth_registration_links(hash,user_id) VALUES(?,?)').run(user.registration_hash, previous.id);
        this.audit(user.id, 'GOOGLE_ACCOUNT_RECOVERED', null, previous.id);
        return { ok: true, recovered: true, ...this.snapshot(previous.id) };
      }
      this.db.prepare("UPDATE growth_members SET google_sub=?,email=?,name=CASE WHEN name='' THEN ? ELSE name END WHERE id=?").run(verified.sub, verified.email, text(verified.name), user.id);
      this.qualify(user.id);
      return { ok: true, ...this.snapshot(user.id) };
    })();
  }
  qualify(userId) {
    this.db.prepare(`UPDATE growth_referrals SET qualified_at=COALESCE(qualified_at,?) WHERE invitee=?
      AND (SELECT COUNT(*) FROM growth_days WHERE user_id=?)>=3
      AND EXISTS(SELECT 1 FROM growth_members WHERE id=? AND google_sub IS NOT NULL AND decision!='DISQUALIFIED')`).run(this.clock(), userId, userId, userId);
  }
  activity(user, kind) {
    if (!['meal', 'water', 'weight', 'activity', 'exercise', 'sleep', 'mood', 'tracker'].includes(kind)) throw growthError(400, 'Unknown activity type.');
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO growth_days VALUES(?,?,?,?)').run(user.id, dayKey(this.clock()), kind, this.clock());
      this.qualify(user.id);
    })();
    return { ok: true };
  }
  signal(user, type, platform) {
    const allowed = ['visit','pwa_prompt_shown','pwa_prompt_accepted','pwa_appinstalled','pwa_standalone_launch'];
    if (!allowed.includes(type)) throw growthError(400, 'Unknown app signal.');
    const day = ['pwa_appinstalled','pwa_prompt_accepted'].includes(type) ? 'once' : dayKey(this.clock());
    this.db.prepare('INSERT OR IGNORE INTO growth_signals VALUES(?,?,?,?,?)').run(user.id,type,day,['Android','iOS'].includes(platform)?platform:'Other',this.clock());
    return { ok: true };
  }
  track(user, code) {
    const ref = this.member(code);
    if (ref.id !== user.id) this.db.prepare('INSERT OR IGNORE INTO growth_opens VALUES(?,?,?)').run(ref.id,user.id,this.clock());
    return { ok: true, referrer: { referralCode: ref.code, displayName: publicName(ref) } };
  }
  rows(period = 'all', limit = 50, includeDisqualified = false) {
    const start = period === 'month' ? Date.parse(dayKey(this.clock()).slice(0,7)+'-01T00:00:00+05:30') : 0;
    return this.db.prepare(`SELECT m.*, COUNT(i.id) accepted,
      COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND r.qualified_at IS NOT NULL THEN 1 ELSE 0 END),0) qualified
      FROM growth_members m LEFT JOIN growth_referrals r ON r.inviter=m.id AND r.accepted_at>=?
      LEFT JOIN growth_members i ON i.id=r.invitee AND i.decision!='DISQUALIFIED'
      WHERE (?=1 OR m.decision!='DISQUALIFIED') GROUP BY m.id ORDER BY (COUNT(i.id)+9*COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND r.qualified_at IS NOT NULL THEN 1 ELSE 0 END),0)) DESC,m.created_at,m.id LIMIT ?`).all(start,includeDisqualified?1:0,limit);
  }
  leaderboard(period) {
    const rows = this.rows(period);
    return { ok:true, asOf:new Date(this.clock()).toISOString(), period:period==='month'?'month':'all', totalMembers:this.db.prepare("SELECT COUNT(*) n FROM growth_members WHERE decision!='DISQUALIFIED'").get().n,
      leaderboard:rows.filter(r=>r.accepted>0).slice(0,50).map((r,i)=>({rank:i+1,userId:r.id,displayName:publicName(r),acceptedReferrals:r.accepted,qualifiedReferrals:r.qualified,score:r.accepted+9*r.qualified})) };
  }
  snapshot(userId) {
    const user = this.db.prepare('SELECT * FROM growth_members WHERE id=?').get(userId);
    const row = this.db.prepare(`SELECT COUNT(i.id) accepted, COALESCE(SUM(CASE WHEN i.id IS NOT NULL AND r.qualified_at IS NOT NULL THEN 1 ELSE 0 END),0) qualified
      FROM growth_referrals r LEFT JOIN growth_members i ON i.id=r.invitee AND i.decision!='DISQUALIFIED' WHERE r.inviter=?`).get(userId);
    const attribution = this.db.prepare('SELECT m.code,m.name,m.id FROM growth_referrals r JOIN growth_members m ON m.id=r.inviter WHERE r.invitee=?').get(userId);
    const reward = this.db.prepare('SELECT * FROM growth_rewards WHERE user_id=?').get(userId);
    return { identity:{userId:user.id,referralCode:user.code,name:user.name,publicAlias:publicName(user),email:user.email||'',phone:user.phone,
      verificationLevel:user.google_sub?'GOOGLE_LINKED':'ANONYMOUS',referredBy:attribution?.code||null,referredByName:attribution?publicName(attribution):null},
      stats:{acceptedCount:row?.accepted||0,qualifiedCount:row?.qualified||0,totalOpens:this.db.prepare('SELECT COUNT(*) n FROM growth_opens WHERE inviter=?').get(userId).n},
      reward:reward && user.decision!=='DISQUALIFIED'?{grantId:reward.grant_id,xp:100,streakShield:1,voucher:{amount:50,status:'NOT_ENABLED'},createdAt:reward.created_at}:null,
      referrals:this.db.prepare(`SELECT m.id userId,m.name displayName,r.accepted_at acceptedAt,r.qualified_at qualifiedAt FROM growth_referrals r JOIN growth_members m ON m.id=r.invitee WHERE r.inviter=? AND m.decision!='DISQUALIFIED' ORDER BY r.accepted_at DESC LIMIT 200`).all(userId) };
  }
  adminOverview() {
    const now=this.clock();
    const count=(sql,...args)=>this.db.prepare(sql).get(...args).n;
    const active=days=>count('SELECT COUNT(DISTINCT user_id) n FROM growth_signals WHERE type=\'visit\' AND at>=?',now-days*DAY);
    const retention=days=>{
      const result=this.db.prepare(`SELECT COUNT(*) eligible, COALESCE(SUM(CASE WHEN EXISTS(
        SELECT 1 FROM growth_signals s WHERE s.user_id=m.id AND s.type='visit'
        AND s.day=strftime('%Y-%m-%d',m.created_at/1000 + ?, 'unixepoch', '+330 minutes')
      ) THEN 1 ELSE 0 END),0) returned FROM growth_members m WHERE m.created_at<=? AND m.decision!='DISQUALIFIED'`).get(days*86400,now-(days+1)*DAY);
      return {...result,percent:result.eligible?Math.round(result.returned/result.eligible*100):null};
    };
    const legacyTable=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='growth_referrals_legacy_v1'").get();
    return {ok:true,overview:{legacyRecordsAwaitingReview:legacyTable?count('SELECT COUNT(*) n FROM growth_referrals_legacy_v1'):0,members:count('SELECT COUNT(*) n FROM growth_members'),dau:active(1),wau:active(7),mau:active(30),
      accepted:count("SELECT COUNT(*) n FROM growth_referrals r JOIN growth_members i ON i.id=r.invitee JOIN growth_members m ON m.id=r.inviter WHERE i.decision!='DISQUALIFIED' AND m.decision!='DISQUALIFIED'"),qualified:count("SELECT COUNT(*) n FROM growth_referrals r JOIN growth_members i ON i.id=r.invitee JOIN growth_members m ON m.id=r.inviter WHERE r.qualified_at IS NOT NULL AND i.decision!='DISQUALIFIED' AND m.decision!='DISQUALIFIED'"),
      pwaSignals:this.db.prepare('SELECT type,platform,COUNT(DISTINCT user_id) members FROM growth_signals GROUP BY type,platform').all(),
      retentionD1:retention(1),retentionD7:retention(7),retentionD30:retention(30)},
      users:this.rows('all',200,true).map(r=>({userId:r.id,name:r.name||publicName(r),email:r.email,phone:r.phone,googleLinked:!!r.google_sub,phoneVerified:false,accepted:r.accepted,qualified:r.qualified,decision:r.decision})),
      audit:this.db.prepare('SELECT user_id userId,action,actor,detail,at FROM growth_audit ORDER BY id DESC LIMIT 100').all()};
  }
  decide(userId, decision, actor, reason) {
    if (!['APPROVE','DISQUALIFY'].includes(decision) || !text(reason,300)) throw growthError(400,'Choose a decision and enter a reason.');
    const user=this.db.prepare('SELECT * FROM growth_members WHERE id=?').get(userId);
    if(!user)throw growthError(404,'Member not found.');
    if(decision==='APPROVE' && !user.google_sub)throw growthError(409,'Verify the member’s Google identity before approving a prize candidate.');
    this.db.transaction(()=>{this.db.prepare('UPDATE growth_members SET decision=? WHERE id=?').run(decision==='APPROVE'?'APPROVED':'DISQUALIFIED',userId);this.audit(userId,decision,actor,reason);})();
    return {ok:true};
  }
}
