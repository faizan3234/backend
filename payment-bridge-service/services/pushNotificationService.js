import crypto from 'crypto';

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_SETTINGS_BYTES = 16 * 1024;

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function normalizeTimezone(value) {
  const timezone = typeof value === 'string' && value.length <= 80 ? value : 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return 'Asia/Kolkata';
  }
}

function normalizeTimedReminder(value, fallbackLabel = '') {
  if (!value || typeof value !== 'object') return { enabled: false, time: '', label: fallbackLabel };
  return {
    enabled: value.enabled === true,
    time: validTime(value.time) ? value.time : '',
    label: String(value.label || fallbackLabel).slice(0, 48)
  };
}

function normalizeSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {};
  const meals = {};
  for (const [key, value] of Object.entries(source.meals || {}).slice(0, 8)) {
    meals[String(key).slice(0, 32)] = normalizeTimedReminder(value, String(value?.label || key));
  }

  return {
    enabled: source.enabled === true,
    sound: source.sound !== false,
    vibrate: source.vibrate !== false,
    meals,
    weight: normalizeTimedReminder(source.weight, 'Morning Weight Check-in'),
    shake: normalizeTimedReminder(source.shake, 'Shake Reminder'),
    streakDefense: normalizeTimedReminder(source.streakDefense, 'Streak Defense'),
    water: {
      enabled: source.water?.enabled === true,
      startHour: clampInt(source.water?.startHour, 0, 23, 9),
      endHour: clampInt(source.water?.endHour, 0, 23, 21),
      intervalMinutes: clampInt(source.water?.intervalMinutes, 30, 720, 120),
      amountMl: clampInt(source.water?.amountMl, 50, 2000, 250)
    }
  };
}

function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function recordSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: {
      p256dh: row.p256dh,
      auth: row.auth
    }
  };
}

function localClock(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const read = type => parts.find(part => part.type === type)?.value;
  const hour = Number(read('hour'));
  const minute = Number(read('minute'));
  return {
    hour,
    minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    dateKey: `${read('year')}-${read('month')}-${read('day')}`
  };
}

export default class PushNotificationService {
  constructor({
    db,
    publicKey = process.env.VAPID_PUBLIC_KEY || '',
    privateKey = process.env.VAPID_PRIVATE_KEY || '',
    subject = process.env.VAPID_SUBJECT || 'mailto:relivcustomercare.in@gmail.com',
    appBaseUrl = process.env.RELIV_APP_BASE_URL || 'https://reliv7.vercel.app',
    schedulerIntervalMs = Number(process.env.PUSH_SCHEDULER_INTERVAL_MS || DEFAULT_INTERVAL_MS)
  } = {}) {
    if (!db) throw new Error('PushNotificationService requires the payment bridge database');
    this.db = db;
    this.publicKey = String(publicKey || '').trim();
    this.privateKey = String(privateKey || '').trim();
    this.subject = String(subject || '').trim();
    this.appBaseUrl = String(appBaseUrl || 'https://reliv7.vercel.app').replace(/\/$/, '');
    this.schedulerIntervalMs = Number.isFinite(schedulerIntervalMs) && schedulerIntervalMs >= 15_000
      ? schedulerIntervalMs
      : DEFAULT_INTERVAL_MS;
    this.webpush = null;
    this.timer = null;
    this.lastTickTime = null;
    this.lastDispatchTime = null;
    this.lastError = null;
    this.ticking = false;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint_hash TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        timezone TEXT NOT NULL,
        last_dispatched_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_updated
        ON push_subscriptions(updated_at);
    `);
  }

  isConfigured() {
    return Boolean(this.webpush && this.publicKey && this.privateKey && this.subject);
  }

  async initialize() {
    try {
      const module = await import('web-push');
      this.webpush = module.default || module;
      if (!this.publicKey || !this.privateKey) {
        console.warn('[PushBridge] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY missing; push notifications disabled.');
        return false;
      }
      this.webpush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
      console.log('[PushBridge] Web Push initialized.');
      return true;
    } catch (error) {
      this.lastError = error.message;
      console.warn('[PushBridge] web-push package unavailable; install web-push@3.6.7 on Oracle.');
      return false;
    }
  }

  getPublicKey() {
    return this.isConfigured() ? this.publicKey : '';
  }

  registerSubscription({ subscription, settings, timezone }) {
    if (!this.isConfigured()) {
      const error = new Error('Push notifications are not configured on Oracle.');
      error.code = 'PUSH_NOT_CONFIGURED';
      throw error;
    }

    const endpoint = String(subscription?.endpoint || '');
    const p256dh = String(subscription?.keys?.p256dh || '');
    const auth = String(subscription?.keys?.auth || '');

    if (!endpoint.startsWith('https://') || endpoint.length > 4096 || !p256dh || !auth) {
      const error = new Error('Valid browser PushSubscription required.');
      error.code = 'INVALID_SUBSCRIPTION';
      throw error;
    }

    const normalized = normalizeSettings(settings);
    const settingsJson = JSON.stringify(normalized);
    if (Buffer.byteLength(settingsJson, 'utf8') > MAX_SETTINGS_BYTES) {
      const error = new Error('Reminder settings are too large.');
      error.code = 'SETTINGS_TOO_LARGE';
      throw error;
    }

    const now = Date.now();
    const hash = endpointHash(endpoint);
    const tz = normalizeTimezone(timezone);

    this.db.prepare(`
      INSERT INTO push_subscriptions (
        endpoint_hash, endpoint, p256dh, auth, settings_json, timezone,
        last_dispatched_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
      ON CONFLICT(endpoint_hash) DO UPDATE SET
        endpoint = excluded.endpoint,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        settings_json = excluded.settings_json,
        timezone = excluded.timezone,
        updated_at = excluded.updated_at
    `).run(hash, endpoint, p256dh, auth, settingsJson, tz, now, now);

    return { ok: true, endpointHash: hash.slice(0, 16), timezone: tz };
  }

  getRecordForSubscription(subscription) {
    const endpoint = String(subscription?.endpoint || '');
    if (!endpoint) return null;
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint_hash = ?')
      .get(endpointHash(endpoint)) || null;
  }

  removeEndpointHash(hash) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash = ?').run(hash);
  }

  async sendRecord(row, payload) {
    if (!this.isConfigured()) {
      return { ok: false, error: 'PUSH_NOT_CONFIGURED' };
    }

    try {
      const settings = normalizeSettings(JSON.parse(row.settings_json || '{}'));
      const response = await this.webpush.sendNotification(
        recordSubscription(row),
        JSON.stringify({ ...payload, sound: settings.sound, vibrate: settings.vibrate }),
        { TTL: 3600, urgency: 'high' }
      );
      return { ok: true, statusCode: response?.statusCode || 201 };
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        this.removeEndpointHash(row.endpoint_hash);
        return { ok: false, expired: true, statusCode: error.statusCode };
      }
      this.lastError = error?.message || 'Push delivery failed';
      console.warn('[PushBridge] Delivery failed:', this.lastError);
      return { ok: false, statusCode: error?.statusCode || 500, error: this.lastError };
    }
  }

  async sendTest(subscription) {
    const row = this.getRecordForSubscription(subscription);
    if (!row) {
      const error = new Error('Register this device before requesting a test push.');
      error.code = 'SUBSCRIPTION_NOT_REGISTERED';
      throw error;
    }

    return this.sendRecord(row, {
      title: 'Reliv Health Companion',
      body: 'Server push is working. Reliv can remind you even when the app is closed.',
      icon: '/app-icon.svg',
      tag: 'reliv-server-push-test',
      url: '/care'
    });
  }

  updateLastDispatched(row, state) {
    this.db.prepare(`
      UPDATE push_subscriptions
      SET last_dispatched_json = ?, updated_at = ?
      WHERE endpoint_hash = ?
    `).run(JSON.stringify(state), Date.now(), row.endpoint_hash);
  }

  async dispatchIfDue(row, state, clock, key, title, body, tag, url = '/care') {
    const lockKey = `${key}_${clock.dateKey}`;
    if (state[lockKey]) return false;

    const result = await this.sendRecord(row, { title, body, icon: '/app-icon.svg', tag, url });
    if (!result.ok) return false;

    state[lockKey] = Date.now();
    this.updateLastDispatched(row, state);
    this.lastDispatchTime = new Date().toISOString();
    return true;
  }

  async evaluateRow(row, now) {
    let settings;
    let state;
    try {
      settings = normalizeSettings(JSON.parse(row.settings_json || '{}'));
      const stored = JSON.parse(row.last_dispatched_json || '{}');
      state = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.fromEntries(Object.entries(stored).filter(([,at]) => Number.isFinite(at) && now.getTime() - at < 7 * 86400000)) : {};
    } catch {
      return 0;
    }
    if (!settings.enabled) return 0;

    const clock = localClock(now, normalizeTimezone(row.timezone));
    let sent = 0;

    for (const [mealKey, meal] of Object.entries(settings.meals)) {
      if (meal.enabled && meal.time === clock.time) {
        sent += await this.dispatchIfDue(
          row, state, clock, `meal_${mealKey}`,
          `Time for ${meal.label || 'your meal'}`,
          `Stay on track with your nutrition goals. Tap to log ${String(meal.label || 'your meal').toLowerCase()} in Reliv.`,
          `meal-${mealKey}`
        ) ? 1 : 0;
      }
    }

    if (settings.weight.enabled && settings.weight.time === clock.time) {
      sent += await this.dispatchIfDue(
        row, state, clock, 'weight',
        'Morning Weight Check-in',
        'Step on the scale for your daily baseline and keep your progress history current.',
        'weight-checkin'
      ) ? 1 : 0;
    }

    if (settings.shake.enabled && settings.shake.time === clock.time) {
      sent += await this.dispatchIfDue(
        row, state, clock, 'shake',
        'Shake Reminder',
        'Time for your scheduled shake. Tap to log it in Reliv.',
        'shake-reminder'
      ) ? 1 : 0;
    }

    if (settings.streakDefense.enabled && settings.streakDefense.time === clock.time) {
      sent += await this.dispatchIfDue(
        row, state, clock, 'streak_defense',
        'Keep Your Streak Safe',
        'Log today before midnight to protect your Reliv streak.',
        'streak-defense'
      ) ? 1 : 0;
    }

    if (settings.water.enabled) {
      const currentMinutes = clock.hour * 60 + clock.minute;
      const startMinutes = settings.water.startHour * 60;
      const endMinutes = settings.water.endHour * 60;
      const elapsed = currentMinutes - startMinutes;
      if (
        currentMinutes >= startMinutes &&
        currentMinutes <= endMinutes &&
        elapsed >= 0 &&
        elapsed % settings.water.intervalMinutes === 0
      ) {
        sent += await this.dispatchIfDue(
          row, state, clock, `water_${currentMinutes}`,
          'Hydration Reminder',
          `Time for about ${settings.water.amountMl} ml of water. Tap to log it in Reliv.`,
          'hydration-reminder'
        ) ? 1 : 0;
      }
    }

    return sent;
  }

  async tick() {
    if (this.ticking || !this.isConfigured()) return;
    this.ticking = true;
    this.lastTickTime = new Date().toISOString();

    try {
      const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY updated_at DESC').all();
      let dispatched = 0;
      const now = new Date();
      for (const row of rows) {
        dispatched += await this.evaluateRow(row, now);
      }
      if (dispatched > 0) {
        console.log(`[PushBridge] Dispatched ${dispatched} scheduled notification(s).`);
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error.message;
      console.error('[PushBridge] Scheduler error:', error);
    } finally {
      this.ticking = false;
    }
  }

  start() {
    if (this.timer || !this.isConfigured()) return false;
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), this.schedulerIntervalMs);
    this.timer.unref?.();
    console.log(`[PushBridge] Scheduler active every ${Math.round(this.schedulerIntervalMs / 1000)}s.`);
    return true;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  health() {
    const activeSubscribers = this.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get()?.count || 0;
    return {
      status: this.isConfigured() ? 'healthy' : 'not_configured',
      service: 'reliv-oracle-push-bridge',
      activeSubscribers,
      schedulerRunning: Boolean(this.timer),
      lastTickTime: this.lastTickTime,
      lastDispatchTime: this.lastDispatchTime,
      webpushAvailable: Boolean(this.webpush),
      vapidConfigured: Boolean(this.publicKey && this.privateKey),
      lastError: this.lastError
    };
  }
}

export { normalizeSettings, normalizeTimezone, validTime };
