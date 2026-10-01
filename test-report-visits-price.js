import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initializeDatabase } from './src/database/db.js';
import settings from './src/services/settingsManager.js';
import { PricingService } from './src/services/pricingService.js';
import { getReportVisitSummary } from './src/services/reportVisits.js';

test('local paid visit counts are stable, normalized, and never expose earlier readings', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sessions (session_id TEXT, customer_data TEXT, service_type TEXT, payment_status TEXT, report_status TEXT)');
  const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 7; i++) insert.run(`s${i}`, JSON.stringify({ email: i === 1 ? ' PERSON@example.com ' : 'person@example.com' }), 'HEALTH_CHECKUP', 'VERIFIED', 'READY');
  insert.run('unpaid', '{"email":"person@example.com"}', 'HEALTH_CHECKUP', 'PENDING', 'READY');
  insert.run('other', '{"email":"other@example.com"}', 'HEALTH_CHECKUP', 'VERIFIED', 'READY');
  assert.deepEqual(getReportVisitSummary(db, 's1', {email:'person@example.com'}), {scanCount:1, identityLinked:true});
  assert.deepEqual(getReportVisitSummary(db, 's7', {email:'Person@Example.com'}), {scanCount:7, identityLinked:true});
  assert.equal(getReportVisitSummary(db, 's7', {email:'person@example.com'}).scanCount, 7);
  assert.deepEqual(getReportVisitSummary(db, 's7', {}), {scanCount:1, identityLinked:false});
  assert.equal(getReportVisitSummary(db, 'other', {email:'other@example.com'}).scanCount, 1);
  db.close();
});

test('existing pricing migrates once to Rs17 and payment uses the same setting', () => {
  initializeDatabase(':memory:');
  settings.initialize();
  settings.set('migration_report_price_17_v1', '');
  settings.set('reportPrice', 27);
  settings.set('health_checkup_price', 100);
  settings.initialize();
  const service = new PricingService({settingsManager:settings});
  assert.equal(settings.getReportPrice(), 17);
  assert.equal(service.calculateAuthoritativePrice({serviceType:'HEALTH_CHECKUP'}).totalPaise, 1700);
  settings.setReportPrice(19);
  settings.initialize();
  assert.equal(service.calculateAuthoritativePrice({serviceType:'HEALTH_CHECKUP'}).totalPaise, 1900);
  settings.set('reportPrice', 'bad');
  assert.throws(() => service.calculateAuthoritativePrice({serviceType:'HEALTH_CHECKUP'}), /Invalid report price/);
});
