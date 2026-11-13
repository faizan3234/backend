import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import PushNotificationService, { normalizeSettings, normalizeTimezone } from './services/pushNotificationService.js';

function fakeWebPush() {
  const sent = [];
  return {
    sent,
    setVapidDetails() {},
    async sendNotification(subscription, payload) {
      sent.push({ subscription, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    }
  };
}

function makeService() {
  const db = new Database(':memory:');
  const service = new PushNotificationService({
    db,
    publicKey: 'public',
    privateKey: 'private',
    subject: 'mailto:test@example.com',
    schedulerIntervalMs: 60_000
  });
  service.webpush = fakeWebPush();
  return { service, db };
}

test('normalizes reminder settings and timezone safely', () => {
  const settings = normalizeSettings({
    enabled: true,
    meals: { breakfast: { enabled: true, time: '08:30', label: 'Breakfast' } },
    water: { enabled: true, startHour: 9, endHour: 21, intervalMinutes: 120, amountMl: 300 }
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.meals.breakfast.time, '08:30');
  assert.equal(settings.water.amountMl, 300);
  assert.equal(normalizeTimezone('Not/A_Timezone'), 'Asia/Kolkata');
});

test('registers one device and only test-pushes registered subscriptions', async () => {
  const { service, db } = makeService();
  const subscription = {
    endpoint: 'https://push.example/subscription/1',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
  };

  const registered = service.registerSubscription({
    subscription,
    settings: { enabled: true },
    timezone: 'Asia/Kolkata'
  });
  assert.equal(registered.ok, true);
  assert.equal(service.health().activeSubscribers, 1);

  const result = await service.sendTest(subscription);
  assert.equal(result.ok, true);
  assert.equal(service.webpush.sent.length, 1);
  assert.equal(service.webpush.sent[0].payload.url, '/care');

  await assert.rejects(
    () => service.sendTest({ endpoint: 'https://push.example/unknown', keys: {} }),
    /Register this device/
  );
  db.close();
});

test('scheduled reminder is deduplicated for the same local date', async () => {
  const { service, db } = makeService();
  const subscription = {
    endpoint: 'https://push.example/subscription/2',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' }
  };
  service.registerSubscription({
    subscription,
    settings: {
      enabled: true,
      meals: { breakfast: { enabled: true, time: '08:30', label: 'Breakfast' } }
    },
    timezone: 'Asia/Kolkata'
  });

  const row = db.prepare('SELECT * FROM push_subscriptions').get();
  const when = new Date('2026-11-07T03:00:00.000Z'); // 08:30 IST
  assert.equal(await service.evaluateRow(row, when), 1);
  const updated = db.prepare('SELECT * FROM push_subscriptions').get();
  assert.equal(await service.evaluateRow(updated, when), 0);
  assert.equal(service.webpush.sent.length, 1);
  db.close();
});

test('cloud hydration matches the phone 90-minute schedule and respects sound preferences', async () => {
 const { service, db } = makeService();
 try {
  service.registerSubscription({subscription:{endpoint:'https://push.example/90',keys:{p256dh:'key',auth:'auth'}},timezone:'Asia/Kolkata',settings:{enabled:true,sound:false,vibrate:false,water:{enabled:true,startHour:9,endHour:21,intervalMinutes:90}}});
  const row=db.prepare('SELECT * FROM push_subscriptions').get();
  assert.equal(await service.evaluateRow(row,new Date('2026-11-07T04:30:00Z')),0);
  assert.equal(await service.evaluateRow(row,new Date('2026-11-07T05:00:00Z')),1);
  assert.equal(service.webpush.sent[0].payload.sound,false);assert.equal(service.webpush.sent[0].payload.vibrate,false);
  db.prepare("UPDATE push_subscriptions SET last_dispatched_json='null'").run();
  assert.equal(await service.evaluateRow(db.prepare('SELECT * FROM push_subscriptions').get(),new Date('2026-11-07T06:30:00Z')),1);
 } finally {db.close();}
});
