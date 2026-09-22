import fs from 'fs';
import crypto from 'crypto';
import { getDb } from '../database/db.js';
import {
  generateConfirmationCode,
  generateRequestId,
  generateRequestNonce,
  signPayload,
  encryptPackage
} from './paymentV2Crypto.js';

function timingSafeHexEqual(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

export class AdPaymentService {
  constructor({
    db = null,
    pepper = process.env.PAYMENT_V2_CODE_PEPPER || '',
    kioskId = process.env.PAYMENT_V2_KIOSK_ID || process.env.KIOSK_ID || 'RELIV-001',
    kioskSigningPrivateKeyPath = process.env.PAYMENT_V2_KIOSK_SIGNING_PRIVATE_KEY_PATH || './config/payment-v2-kiosk-private-key.pem',
    cloudEncryptionPublicKeyPath = process.env.PAYMENT_V2_CLOUD_ENCRYPTION_PUBLIC_KEY_PATH || './config/payment-v2-cloud-encryption-public-key.pem',
    paymentUrlBase = 'https://reliv7.vercel.app/pay',
    ttlSeconds = Number(process.env.AD_PAYMENT_TTL_SECONDS || 900),
    maxAttempts = Number(process.env.AD_PAYMENT_MAX_ATTEMPTS || 5),
    activationGraceMs = Number(process.env.AD_PAYMENT_ACTIVATION_GRACE_MS || 86400000)
  } = {}) {
    this._db = db;
    this.pepper = String(pepper || '').trim();
    this.kioskId = kioskId;
    this.kioskSigningPrivateKeyPath = kioskSigningPrivateKeyPath;
    this.cloudEncryptionPublicKeyPath = cloudEncryptionPublicKeyPath;
    this.paymentUrlBase = paymentUrlBase;
    this.ttlSeconds = ttlSeconds;
    this.maxAttempts = maxAttempts;
    this.activationGraceMs = activationGraceMs;
    this._privateKey = null;
    this._cloudPublicKey = null;
  }

  get db() {
    if (!this._db) this._db = getDb();
    return this._db;
  }

  getPrivateKey() {
    if (this._privateKey) return this._privateKey;
    if (!fs.existsSync(this.kioskSigningPrivateKeyPath)) {
      throw new Error('Kiosk signing key is not configured');
    }
    this._privateKey = fs.readFileSync(this.kioskSigningPrivateKeyPath, 'utf8');
    return this._privateKey;
  }

  getCloudPublicKey() {
    if (this._cloudPublicKey) return this._cloudPublicKey;
    if (!fs.existsSync(this.cloudEncryptionPublicKeyPath)) {
      throw new Error('Cloud payment public key is not configured');
    }
    this._cloudPublicKey = fs.readFileSync(this.cloudEncryptionPublicKeyPath, 'utf8');
    return this._cloudPublicKey;
  }

  assertConfigured() {
    if (!this.pepper) {
      const err = new Error('Ad payment verification pepper is not configured');
      err.code = 'AD_PAYMENT_NOT_CONFIGURED';
      throw err;
    }
    this.getPrivateKey();
    this.getCloudPublicKey();
  }

  codeHmac({ requestId, requestNonce, campaignId, amount, mediaSHA256, confirmationCode }) {
    const message = [
      'RELIV_AD_CAMPAIGN',
      requestId,
      requestNonce,
      campaignId,
      this.kioskId,
      amount,
      mediaSHA256,
      confirmationCode
    ].join('|');
    return crypto.createHmac('sha256', this.pepper).update(message).digest('hex');
  }

  expireStaleRequests() {
    const now = Date.now();
    this.db.prepare(`
      UPDATE ad_payment_requests
      SET status = 'EXPIRED'
      WHERE status = 'ACTIVE' AND (expires_at + ?) <= ?
    `).run(this.activationGraceMs, now);
  }

  createPaymentRequest(campaignId) {
    this.assertConfigured();
    this.expireStaleRequests();

    const campaign = this.db.prepare('SELECT * FROM ad_campaigns WHERE campaign_id = ?').get(campaignId);
    if (!campaign) {
      const err = new Error('Advertising campaign not found');
      err.code = 'AD_CAMPAIGN_NOT_FOUND';
      throw err;
    }
    if (campaign.status !== 'PENDING_PAYMENT') {
      const err = new Error(`Campaign cannot be paid while status is ${campaign.status}`);
      err.code = 'INVALID_AD_CAMPAIGN_STATE';
      throw err;
    }
    if (!campaign.prepared_path || !campaign.media_sha256 || !campaign.price_paise) {
      const err = new Error('Campaign media has not been prepared');
      err.code = 'AD_MEDIA_NOT_READY';
      throw err;
    }

    const venues = this.db.prepare(`
      SELECT * FROM ad_campaign_venues
      WHERE campaign_id = ?
      ORDER BY venue_id
    `).all(campaignId);

    if (!venues.length) {
      const err = new Error('Campaign has no venue schedule');
      err.code = 'AD_SCHEDULE_MISSING';
      throw err;
    }

    const existing = this.db.prepare(`
      SELECT * FROM ad_payment_requests
      WHERE campaign_id = ? AND status = 'ACTIVE'
      ORDER BY created_at DESC LIMIT 1
    `).get(campaignId);

    if (existing) {
      if (existing.expires_at <= Date.now()) throw new Error('This payment link expired. If you paid, enter your code at the kiosk. Do not pay again; ask the kiosk administrator for help.');
      return {
        ok: true,
        campaignId,
        requestId: existing.request_id,
        expiresAt: existing.expires_at,
        paymentUrl: `${this.paymentUrlBase}#p=${existing.encrypted_package}`,
        amount: existing.amount
      };
    }

    if (this.db.prepare('SELECT 1 FROM ad_payment_requests WHERE campaign_id=?').get(campaignId)) {
      throw new Error('This campaign already has a payment request. Ask the kiosk administrator for recovery; do not pay again.');
    }
    const requestId = generateRequestId();
    const requestNonce = generateRequestNonce();
    const candidates = this.activationCandidates();
    if (candidates.filter(row => row.status === 'ACTIVE').length >= 32) throw new Error('Too many bookings awaiting activation. Please try later.');
    let confirmationCode;
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = generateConfirmationCode();
      if (!candidates.some(row => this.matchesCode(row, candidate))) { confirmationCode = candidate; break; }
    }
    if (!confirmationCode) throw new Error('Unable to reserve an activation code. Please retry.');
    const now = Date.now();
    const expiresAt = now + this.ttlSeconds * 1000;

    const targetVenueIds = venues.map(v => v.venue_id);
    const startDate = venues[0].start_date;
    const endDate = venues[0].end_date;
    const isAllDay = venues[0].is_all_day === 1;
    const dailyStartMinute = venues[0].daily_start_minute;
    const dailyEndMinute = venues[0].daily_end_minute;

    const adCampaign = {
      version: 1,
      campaignId,
      pricingVersion: campaign.pricing_version,
      durationDays: campaign.duration_days,
      targetVenueIds,
      startDate,
      endDate,
      isAllDay,
      dailyStartMinute,
      dailyEndMinute,
      mediaSHA256: campaign.media_sha256,
      mediaType: campaign.media_type,
      durationSeconds: campaign.duration_seconds
    };

    const payload = {
      v: 2,
      type: 'RELIV_AD_PAYMENT_REQUEST',
      purpose: 'RELIV_AD_CAMPAIGN',
      kioskId: this.kioskId,
      requestId,
      requestNonce,
      sessionId: `AD:${campaignId}`,
      transactionId: `AD:${campaignId}`,
      amount: campaign.price_paise,
      currency: 'INR',
      serviceType: 'AD_CAMPAIGN',
      confirmationCode,
      issuedAt: now,
      expiresAt,
      adCampaign
    };

    const signature = signPayload(payload, this.getPrivateKey());
    const encryptedPackage = encryptPackage(
      { payload, signature },
      this.getCloudPublicKey()
    );

    const codeHmac = this.codeHmac({
      requestId,
      requestNonce,
      campaignId,
      amount: campaign.price_paise,
      mediaSHA256: campaign.media_sha256,
      confirmationCode
    });

    this.db.prepare(`
      INSERT INTO ad_payment_requests (
        request_id, request_nonce, campaign_id, kiosk_id, amount,
        code_hmac, encrypted_package, status, attempt_count, max_attempts,
        created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?, ?)
    `).run(
      requestId,
      requestNonce,
      campaignId,
      this.kioskId,
      campaign.price_paise,
      codeHmac,
      encryptedPackage,
      this.maxAttempts,
      now,
      expiresAt
    );

    return {
      ok: true,
      campaignId,
      requestId,
      expiresAt,
      paymentUrl: `${this.paymentUrlBase}#p=${encryptedPackage}`,
      amount: campaign.price_paise
    };
  }

  activationCandidates() {
    return this.db.prepare(`SELECT r.*,c.media_sha256,c.status AS campaign_status
      FROM ad_payment_requests r JOIN ad_campaigns c ON c.campaign_id=r.campaign_id
      WHERE r.status IN ('ACTIVE','VERIFIED') AND r.expires_at + ? > ?`).all(this.activationGraceMs, Date.now());
  }

  matchesCode(row, code) {
    return timingSafeHexEqual(row.code_hmac, this.codeHmac({
      requestId:row.request_id, requestNonce:row.request_nonce, campaignId:row.campaign_id,
      amount:row.amount, mediaSHA256:row.media_sha256, confirmationCode:code
    }));
  }

  // One durable kiosk-wide budget; changing IP or request ID cannot bypass it.
  consumeActivationAttempt() {
    const key = 'adActivationAttempts';
    const stored = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    let state;
    try { state = JSON.parse(stored?.value || 'null'); } catch { state = null; }
    if (!state || state.until <= Date.now()) state = { count:0, until:Date.now() + 900000 };
    if (state.count >= 5) return false;
    state.count++;
    this.db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, JSON.stringify(state));
    return true;
  }

  verifyCodeOnly(code) {
    this.assertConfigured();
    this.expireStaleRequests();
    if (!this.consumeActivationAttempt()) return { ok:false, code:'RATE_LIMITED', message:'Too many code attempts. Wait 15 minutes and retry. Do not pay again.' };
    if (!/^\d{4}$/.test(code)) return { ok:false, code:'INVALID_CODE', message:'Enter the 4-digit code shown after payment.' };
    const matches = this.activationCandidates().filter(row => this.matchesCode(row, code));
    if (matches.length !== 1) return { ok:false, code:'INVALID_CODE', message:'Code not recognized. Check your phone or ask the kiosk administrator. Do not pay again.' };
    const row = matches[0];
    const result = row.status === 'VERIFIED'
      ? { ok:true, campaignId:row.campaign_id, status:row.campaign_status }
      : this.verifyCode({ campaignId:row.campaign_id, requestId:row.request_id, code }, true);
    if (result.ok) {
      const state = JSON.parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get('adActivationAttempts').value);
      state.count = Math.max(0, state.count - 1);
      this.db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(state),'adActivationAttempts');
    }
    return result;
  }

  verifyCode({ campaignId, requestId, code }, attemptAlreadyCounted = false) {
    this.assertConfigured();
    this.expireStaleRequests();
    if (!attemptAlreadyCounted && !this.consumeActivationAttempt()) return { ok:false, code:'RATE_LIMITED', message:'Too many code attempts. Wait 15 minutes; do not pay again.' };

    if (!/^\d{4}$/.test(String(code || ''))) {
      return { ok: false, code: 'INVALID_CODE', message: 'Enter the 4-digit code shown on your phone.' };
    }

    const req = this.db.prepare(`
      SELECT r.*, c.media_sha256
      FROM ad_payment_requests r
      JOIN ad_campaigns c ON c.campaign_id = r.campaign_id
      WHERE r.request_id = ? AND r.campaign_id = ?
    `).get(requestId, campaignId);

    if (!req || req.status !== 'ACTIVE') {
      return { ok: false, code: 'REQUEST_NOT_ACTIVE', message: 'This activation request is no longer active.' };
    }
    if ((req.expires_at + this.activationGraceMs) <= Date.now()) {
      this.db.prepare("UPDATE ad_payment_requests SET status='EXPIRED' WHERE request_id=?").run(requestId);
      return { ok: false, code: 'REQUEST_EXPIRED', message: 'Activation expired. Ask the kiosk administrator; do not pay again.' };
    }
    if (req.attempt_count >= req.max_attempts) {
      this.db.prepare("UPDATE ad_payment_requests SET status='LOCKED' WHERE request_id=?").run(requestId);
      return { ok: false, code: 'LOCKED', message: 'Too many incorrect attempts. Ask the kiosk administrator for help. Do not pay again.' };
    }

    const calculated = this.codeHmac({
      requestId: req.request_id,
      requestNonce: req.request_nonce,
      campaignId: req.campaign_id,
      amount: req.amount,
      mediaSHA256: req.media_sha256,
      confirmationCode: String(code)
    });

    if (!timingSafeHexEqual(req.code_hmac, calculated)) {
      const attempts = req.attempt_count + 1;
      const locked = attempts >= req.max_attempts;
      this.db.prepare(`
        UPDATE ad_payment_requests
        SET attempt_count = ?, status = ?
        WHERE request_id = ?
      `).run(attempts, locked ? 'LOCKED' : 'ACTIVE', requestId);
      return {
        ok: false,
        code: locked ? 'LOCKED' : 'INVALID_CODE',
        message: locked ? 'Too many incorrect attempts. Ask the kiosk administrator for help. Do not pay again.' : 'That code does not match. Check your phone and try again.',
        attemptsLeft: Math.max(0, req.max_attempts - attempts)
      };
    }

    const now = Date.now();
    const currentVenue = process.env.RELIV_AD_CURRENT_VENUE || 'gurukul';
    const clock = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', hourCycle:'h23'
    }).formatToParts(new Date(now));
    const part = type => clock.find(value => value.type === type).value;
    const today = `${part('year')}-${part('month')}-${part('day')}`;
    const minute = Number(part('hour')) * 60 + Number(part('minute'));

    const currentAssignment = this.db.prepare(`
      SELECT * FROM ad_campaign_venues WHERE campaign_id = ? AND venue_id = ?
    `).get(campaignId, currentVenue);

    const lastWindowEnded = currentAssignment && currentAssignment.end_date === today &&
      currentAssignment.is_all_day !== 1 && minute >= currentAssignment.daily_end_minute;
    if (!currentAssignment || currentAssignment.end_date < today || lastWindowEnded) {
      return { ok:false, code:'AD_SCHEDULE_UNAVAILABLE', message:'This campaign has no remaining schedule on this kiosk. Ask the kiosk administrator for help. Do not pay again.' };
    }
    const playingNow = currentAssignment.start_date <= today &&
      (currentAssignment.is_all_day === 1 ||
        (minute >= currentAssignment.daily_start_minute && minute < currentAssignment.daily_end_minute));

    const needsApproval = currentVenue === 'dps-megacity';
    const currentStatus = needsApproval
      ? 'PENDING_APPROVAL'
      : (playingNow ? 'ACTIVE' : 'SCHEDULED');

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE ad_payment_requests SET status='VERIFIED', verified_at=? WHERE request_id=?
      `).run(now, requestId);

      this.db.prepare(`
        UPDATE ad_campaigns
        SET status=?, paid_at=?, activated_at=?, updated_at=?
        WHERE campaign_id=?
      `).run(currentStatus, now, now, now, campaignId);

      if (currentAssignment) {
        this.db.prepare(`
          UPDATE ad_campaign_venues SET status=? WHERE campaign_id=? AND venue_id=?
        `).run(currentStatus, campaignId, currentVenue);
      }
    });
    tx();

    return {
      ok: true,
      campaignId,
      status: currentStatus,
      scheduled: currentStatus !== 'ACTIVE'
    };
  }
}

export default new AdPaymentService();
