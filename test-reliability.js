import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import { createAdminAuth } from './src/services/adminAuth.js';
import PDFGenerator from './src/services/pdfGenerator.js';
import EmailQueueService from './src/services/emailQueue.js';
import settings from './src/services/settingsManager.js';
import { initializeDatabase, closeDatabase } from './src/database/db.js';
import { createSpeechConfigHandler, validateSpeechConfig } from './src/routes/speechConfig.js';

const schema = readFileSync(new URL('./src/database/schema.sql', import.meta.url), 'utf8');
function fixture() {
  const db = new Database(':memory:'); db.exec(schema);
  db.prepare("INSERT INTO sessions(session_id,kiosk_id,customer_data,expires_at) VALUES('TEST','TEST',?,datetime('now','+1 hour'))")
    .run(JSON.stringify({ name: '<script>Test</script>', email: 'test@example.invalid' }));
  db.prepare("INSERT INTO transactions(transaction_id,session_id,type,amount,status,verified) VALUES('TX','TEST','HEALTH_CHECKUP',2700,'VERIFIED',1)").run();
  return db;
}
test('admin credentials, protected writes, expiry, password reset and logout', async (t) => {
  let credentials = {}, resets = {}, clock = Date.now(), recovery;
  const auth = createAdminAuth({
    loadCredentials: () => structuredClone(credentials), saveCredentials: v => { credentials = structuredClone(v); },
    loadResets: () => structuredClone(resets), saveResets: v => { resets = structuredClone(v); },
    queueReset: (email, code) => { recovery = { email, code }; }, now: () => clock,
    bootstrapEmail: 'admin@example.invalid', bootstrapPassword: 'Synthetic-test-password',
  });
  const app = express(); app.use(express.json()); app.use(auth.protectWrites); auth.register(app);
  app.put('/api/kits/1', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (path, body, token, method = 'POST') => {
    const res = await fetch('http://127.0.0.1:' + server.address().port + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  };
  const login = (password = 'Synthetic-test-password') => request('/api/check-login', { email: 'ADMIN@example.invalid', password });
  assert.equal((await login('admin123')).status, 401);
  for (const path of ['/api/kits/1', '/API/KITS/1']) assert.equal((await request(path, {}, null, 'PUT')).status, 401);
  const first = await login(); assert.equal(first.status, 200); assert.match(first.body.token, /^[a-f0-9]{64}$/);
  assert.equal((await request('/api/kits/1', {}, first.body.token, 'PUT')).status, 200);
  clock += 8 * 60 * 60 * 1000;
  assert.equal((await request('/api/kits/1', {}, first.body.token, 'PUT')).status, 401);
  const second = await login();
  await request('/api/send-reset-email', { to: 'unknown@example.invalid' }); assert.equal(recovery, undefined);
  await request('/api/send-reset-email', { to: 'admin@example.invalid' }); assert.match(recovery.code, /^\d{6}$/);
  const reset = { email: recovery.email, token: recovery.code, newPassword: 'Replacement-test-password' };
  assert.equal((await request('/api/confirm-reset', { ...reset, token: '000000' })).status, 400);
  assert.equal((await request('/api/confirm-reset', reset)).status, 200);
  assert.equal((await request('/api/confirm-reset', reset)).status, 400);
  assert.equal((await request('/api/kits/1', {}, second.body.token, 'PUT')).status, 401);
  assert.equal((await login()).status, 401);
  const third = await login(reset.newPassword); assert.equal(third.status, 200);
  await request('/api/admin/logout', {}, third.body.token);
  assert.equal((await request('/api/kits/1', {}, third.body.token, 'PUT')).status, 401);
});
test('real PDFs persist required receipt fields and reuse concurrent/repeated generation', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reliv-pdf-')), db = fixture();
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const generators = [new PDFGenerator(db), new PDFGenerator(db)];
  generators.forEach(g => { g.reportsDir = dir; g.receiptsDir = dir; });
  const patient = { name: 'Synthetic Test', age: 40, gender: 'female' }, health = { vitals: { height: 170, weight: 65, oxygen: 98, bpm: 70 } };
  const reports = await Promise.all(generators.map(g => g.generateHealthReport('TEST', patient, health)));
  assert.equal(reports[0].reportId, reports[1].reportId); assert.ok(reports[0].pdfBuffer.length > 1000);
  assert.equal((await generators[0].generateHealthReport('TEST', patient, health)).reportId, reports[0].reportId);
  unlinkSync(reports[0].pdfPath);
  assert.notEqual((await generators[0].generateHealthReport('TEST', patient, health)).reportId, reports[0].reportId);
  const tx = { transaction_id: 'TX', amount: 2700, cart: [], status: 'VERIFIED' };
  const receipts = await Promise.all(generators.map(g => g.generateReceipt('TEST', patient, tx)));
  assert.equal(receipts[0].receiptId, receipts[1].receiptId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, 1);
  assert.equal(db.prepare('SELECT amount FROM receipts').get().amount, 2700);
  assert.ok(receipts[0].pdfBuffer.length > 1000);
});
test('email retries deduplicate, reject invalid PDFs and stop after five failures', async (t) => {
  const db = fixture(); t.after(() => db.close()); const sent = [];
  const queue = new EmailQueueService(db, { sendMail: async mail => { sent.push(mail); return { accepted: [mail.to] }; } });
  const payload = { reportId: 'REPORT', pdfBuffer: Buffer.from('%PDF-1.4 synthetic test') };
  const id = queue.queueEmail('TEST', 'EMAIL_REPORT', payload);
  assert.equal(queue.queueEmail('TEST', 'EMAIL_REPORT', payload), id);
  await Promise.all([queue.processQueue(), queue.processQueue()]); assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes('&lt;script&gt;'));
  const bad = queue.queueEmail('TEST', 'EMAIL_RECEIPT', { receiptId: 'BAD', pdfBuffer: Buffer.from('not pdf') });
  for (let i = 0; i < 6; i++) await queue.processQueue();
  assert.deepEqual(db.prepare('SELECT status,attempts FROM event_queue WHERE event_id=?').get(bad), { status: 'FAILED', attempts: 5 });
  queue.queueEmail('TEST', 'EMAIL_ADMIN_RESET', { text: 'Synthetic code', expiresAt: Date.now() + 60000 });
  queue.queueEmail('TEST', 'EMAIL_ADMIN_RESET', { text: 'Expired code', expiresAt: 1 });
  await queue.processQueue(); assert.equal(sent.length, 2); assert.equal(sent[1].attachments, undefined);
  assert.equal(queue.getQueueStats().failed, 2);
});
test('queue migration preserves legacy events and allows recovery emails', t => {
  const dir = mkdtempSync(join(tmpdir(), 'reliv-migration-')), path = join(dir, 'test.db');
  t.after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
  const old = new Database(path); old.exec(schema.replaceAll("'EMAIL_ADMIN_RESET', ", ''));
  old.prepare("INSERT INTO event_queue(event_id,type,payload) VALUES('OLD','EMAIL_REPORT','{}')").run(); old.close();
  const db = initializeDatabase(path);
  assert.equal(db.prepare("SELECT status FROM event_queue WHERE event_id='OLD'").get().status, 'PENDING');
  db.prepare("INSERT INTO event_queue(event_id,type,payload) VALUES('RESET','EMAIL_ADMIN_RESET','{}')").run();
});
test('report price persists and speech changes work offline', async t => {
  const db = fixture(); settings.db = db; t.after(() => { settings.db = null; db.close(); });
  assert.equal(settings.setReportPrice(29.5), 29.5); assert.equal(settings.getReportPrice(), 29.5);
  for (const price of [-1, NaN, Infinity, '29abc']) assert.throws(() => settings.setReportPrice(price));
  let body;
  await createSpeechConfigHandler({ getDb: () => null, isConnected: () => false, getLocal: () => ({ payment: { en: 'Enter your code' } }) })({}, { set() {}, json: v => { body = v; } });
  assert.equal(body.payment.en, 'Enter your code'); assert.ok(body.payment.bn);
  assert.throws(() => validateSpeechConfig({ payment: { en: 1 } }));
  assert.throws(() => validateSpeechConfig(JSON.parse('{"__proto__":{"en":"bad"}}')));
});
