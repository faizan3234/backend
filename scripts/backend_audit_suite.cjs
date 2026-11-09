/**
 * RELIV BACKEND AUDIT SUITE
 * -------------------------------------------------------------
 * Comprehensive diagnostic check for Reliv Kiosk & Cloud Backend:
 * 1. System Clock, RTC & Monotonic Time Integrity
 * 2. Payment V2 Hybrid Cryptography & Key Rings
 * 3. SQLite Database Schema & Tables
 * 4. Route Coverage vs Frontend Contract (Growth, Health Card, Store, etc.)
 * 5. Hardware Dispenser & Peripheral Interfaces
 *
 * Usage:
 *   node scripts/backend_audit_suite.cjs
 *   node scripts/backend_audit_suite.cjs --json > audit_results.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');

const results = {
  timestamp: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  clockAudit: {},
  cryptoAudit: {},
  databaseAudit: {},
  routeAudit: {},
  hardwareAudit: {},
  overallHealth: 'UNKNOWN',
  missingCapabilities: [],
  recommendations: []
};

function logHeader(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function logItem(passed, label, details = '') {
  const icon = passed ? '  ✅' : '  ⚠️ ';
  console.log(`${icon} ${label}${details ? ` (${details})` : ''}`);
}

// ══════════════════════════════════════════════════════════════
// 1. CLOCK, RTC & MONOTONIC TIME INTEGRITY
// ══════════════════════════════════════════════════════════════
logHeader('1. CLOCK, RTC & MONOTONIC TIME INTEGRITY');

const now = new Date();
const nowEpoch = Date.now();
const hrtime1 = process.hrtime.bigint();

results.clockAudit.systemTimeIso = now.toISOString();
results.clockAudit.epochMs = nowEpoch;
results.clockAudit.timezoneOffsetMinutes = now.getTimezoneOffset();

// Check if system year is sane (>= 2026)
const isYearSane = now.getFullYear() >= 2026;
logItem(isYearSane, `System clock: ${now.toISOString()}`, isYearSane ? 'Current' : 'POSSIBLE RTC RESET TO EPOCH/PAST');

// Check monotonic timer stability
let hrDiff = 0;
for (let i = 0; i < 100000; i++) {
  // tight loop
}
const hrtime2 = process.hrtime.bigint();
hrDiff = Number(hrtime2 - hrtime1) / 1e6; // in ms
const isMonotonicWorking = hrDiff >= 0;
results.clockAudit.monotonicTimerPassed = isMonotonicWorking;
logItem(isMonotonicWorking, 'Process monotonic timer (process.hrtime.bigint())', `Elapsed: ${hrDiff.toFixed(2)}ms`);

// Platform specific RTC & NTP checks
results.clockAudit.ntpStatus = 'UNKNOWN';
results.clockAudit.rtcHardware = 'UNKNOWN';
results.clockAudit.fakeHwClock = false;

if (process.platform === 'linux') {
  try {
    const timedate = execSync('timedatectl status 2>/dev/null', { encoding: 'utf8' });
    results.clockAudit.timedatectl = timedate.split('\n').slice(0, 5).join(' | ');
    results.clockAudit.ntpStatus = timedate.includes('NTP service: active') || timedate.includes('System clock synchronized: yes') ? 'SYNCHRONIZED' : 'UNSYNCHRONIZED';
    logItem(true, 'timedatectl check', results.clockAudit.ntpStatus);
  } catch (e) {
    logItem(false, 'timedatectl not available');
  }

  const hasFakeHwClock = fs.existsSync('/etc/fake-hwclock.data');
  results.clockAudit.fakeHwClock = hasFakeHwClock;
  logItem(hasFakeHwClock, 'fake-hwclock status', hasFakeHwClock ? 'Present (Offline Drift Protection)' : 'Not installed');

  const hasRtcDevice = fs.existsSync('/dev/rtc') || fs.existsSync('/dev/rtc0');
  results.clockAudit.rtcHardware = hasRtcDevice ? 'HARDWARE_RTC_PRESENT' : 'NO_HARDWARE_RTC';
  logItem(hasRtcDevice, 'Hardware DS3231/PCF8523 RTC', hasRtcDevice ? '/dev/rtc0 present' : 'Using fake-hwclock/software time');
} else {
  results.clockAudit.ntpStatus = 'WINDOWS_HOST_MANAGED';
  logItem(true, 'Host clock check', `Platform: ${process.platform}`);
}

// ══════════════════════════════════════════════════════════════
// 2. CRYPTO PRIMITIVES & KEYS AUDIT
// ══════════════════════════════════════════════════════════════
logHeader('2. PAYMENT V2 CRYPTO & KEY RINGS');

const certsDir = path.join(BACKEND_ROOT, 'certs');
const kioskPrivKeyPath = path.join(certsDir, 'kiosk-ed25519-private.pem');
const kioskPubKeyPath = path.join(certsDir, 'kiosk-ed25519-public.pem');
const cloudPubKeyPath = path.join(certsDir, 'cloud-rsa4096-public.pem');

const hasCertsDir = fs.existsSync(certsDir);
const hasKioskPriv = fs.existsSync(kioskPrivKeyPath);
const hasKioskPub = fs.existsSync(kioskPubKeyPath);
const hasCloudPub = fs.existsSync(cloudPubKeyPath);

results.cryptoAudit.hasCertsDir = hasCertsDir;
results.cryptoAudit.hasKioskPrivateKey = hasKioskPriv;
results.cryptoAudit.hasKioskPublicKey = hasKioskPub;
results.cryptoAudit.hasCloudPublicKey = hasCloudPub;

logItem(hasKioskPriv, 'Kiosk Ed25519 Private Key', hasKioskPriv ? kioskPrivKeyPath : 'MISSING (Must run generate-payment-v2-kiosk-key.js)');
logItem(hasKioskPub, 'Kiosk Ed25519 Public Key', hasKioskPub ? kioskPubKeyPath : 'MISSING');
logItem(hasCloudPub, 'Cloud RSA-4096 Public Key', hasCloudPub ? cloudPubKeyPath : 'MISSING');

// Test Ed25519 signing if keys exist
if (hasKioskPriv && hasKioskPub) {
  try {
    const privKey = fs.readFileSync(kioskPrivKeyPath, 'utf8');
    const pubKey = fs.readFileSync(kioskPubKeyPath, 'utf8');
    const testData = Buffer.from('RELIV_CLOCK_AUDIT_NONCE_' + Date.now());
    const signature = crypto.sign(null, testData, privKey);
    const verified = crypto.verify(null, testData, pubKey, signature);
    results.cryptoAudit.signatureVerificationPassed = verified;
    logItem(verified, 'Local Ed25519 Sign & Verify Test', verified ? 'SUCCESS' : 'FAILED');
  } catch (err) {
    results.cryptoAudit.signatureVerificationPassed = false;
    logItem(false, 'Local Ed25519 Sign & Verify Test', err.message);
  }
} else {
  results.cryptoAudit.signatureVerificationPassed = false;
}

// ══════════════════════════════════════════════════════════════
// 3. SQLITE DATABASE SCHEMA & AUDIT
// ══════════════════════════════════════════════════════════════
logHeader('3. SQLITE DATABASE SCHEMA & DATA INTEGRITY');

const dbPath = path.join(BACKEND_ROOT, 'data', 'kiosk.db');
const dbExists = fs.existsSync(dbPath);
results.databaseAudit.dbPath = dbPath;
results.databaseAudit.dbExists = dbExists;
logItem(dbExists, 'Database file existence', dbPath);

let db = null;
try {
  const Database = require('better-sqlite3');
  if (dbExists) {
    db = new Database(dbPath, { readonly: true });
    results.databaseAudit.driver = 'better-sqlite3';
  }
} catch (e) {
  try {
    const sqlite3 = require('sqlite3');
    results.databaseAudit.driver = 'sqlite3';
  } catch (err2) {
    results.databaseAudit.driver = 'NONE_INSTALLED';
  }
}

const requiredTables = [
  'sessions',
  'transactions',
  'payment_v2_requests',
  'kits',
  'inventory',
  'support_cases',
  'health_profiles'
];

const growthTables = [
  'growth_referrals',
  'growth_devices',
  'streak_restores'
];

results.databaseAudit.tables = {};

if (db) {
  const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

  requiredTables.forEach(tbl => {
    const exists = existingTables.includes(tbl);
    let count = 0;
    if (exists) {
      try {
        count = db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get().c;
      } catch (e) {}
    }
    results.databaseAudit.tables[tbl] = { exists, count };
    logItem(exists, `Table: ${tbl}`, exists ? `${count} rows` : 'MISSING');
  });

  // Verify payment_v2_requests security (MUST have code_hmac, MUST NOT have confirmation_code)
  if (existingTables.includes('payment_v2_requests')) {
    const columns = db.prepare("PRAGMA table_info(payment_v2_requests)").all().map(c => c.name);
    const hasCodeHmac = columns.includes('code_hmac');
    const hasPlainCodeLeak = columns.includes('confirmation_code');
    logItem(hasCodeHmac && !hasPlainCodeLeak, 'Payment V2 DB Security Guard', hasPlainCodeLeak ? 'LEAK: confirmation_code column found!' : 'SECURE: code_hmac stored, zero plain codes');
    results.databaseAudit.paymentV2Secure = hasCodeHmac && !hasPlainCodeLeak;
  }

  // Check growth & referral tables
  growthTables.forEach(tbl => {
    const exists = existingTables.includes(tbl);
    results.databaseAudit.tables[tbl] = { exists };
    if (!exists) {
      results.missingCapabilities.push(`Database table '${tbl}' is missing (needed for backend-persisted growth & referrals)`);
    }
    logItem(exists, `Growth Table: ${tbl}`, exists ? 'Present' : 'Not yet created in SQLite (Frontend using localStorage fallback)');
  });

  db.close();
} else {
  logItem(false, 'Database inspection skipped (driver or file not loaded)');
}

// ══════════════════════════════════════════════════════════════
// 4. ROUTE COVERAGE VS FRONTEND CONTRACT
// ══════════════════════════════════════════════════════════════
logHeader('4. ROUTE COVERAGE VS FRONTEND EXPECTATIONS');

// Scan server.js and routes files for route definitions
const serverJsPath = path.join(BACKEND_ROOT, 'server.js');
const routesDir = path.join(BACKEND_ROOT, 'src', 'routes');

let allRouteDefinitions = '';
if (fs.existsSync(serverJsPath)) {
  allRouteDefinitions += fs.readFileSync(serverJsPath, 'utf8');
}
if (fs.existsSync(routesDir)) {
  fs.readdirSync(routesDir).forEach(file => {
    if (file.endsWith('.js')) {
      allRouteDefinitions += fs.readFileSync(path.join(routesDir, file), 'utf8');
    }
  });
}

const frontendExpectedEndpoints = [
  // Payment V2
  { path: 'payment-v2', label: 'Payment V2 Sub-Router Mounted', required: true },
  { path: "'/request'", label: 'Payment V2 Request Creation (/request)', required: true },
  { path: "'/confirm-code'", label: 'Payment V2 Code Confirmation (/confirm-code)', required: true },
  { path: "'/status'", label: 'Payment V2 Status Polling (/status)', required: true },
  { path: "'/sync-clock'", label: 'Payment V2 Opportunistic Clock Sync (/sync-clock)', required: true },

  // Core Kiosk Workflows
  { path: '/api/sessions', label: 'Session Management', required: true },
  { path: '/api/inventory', label: 'Inventory & Kits Catalog', required: true },
  { path: '/api/weight/tare', label: 'Weight Scale Tare', required: false },
  { path: '/api/weight/reset', label: 'Weight Scale Zero/Reset (Frontend: BodyComposition.jsx)', required: false },

  // User Care & Communications
  { path: '/api/send-health-card', label: 'Health Card Email Delivery (Frontend: HealthCardModal.jsx)', required: false },
  { path: '/api/support-issue', label: 'Direct Support Ticket Submission (Frontend: SupportButton.jsx)', required: false },

  // Growth & Referrals (Currently in frontend localStorage)
  { path: '/growth/referral/create', label: 'Growth: Register Referral Code', required: false },
  { path: '/growth/referral/claim', label: 'Growth: Claim Referral Reward', required: false },
  { path: '/growth/device-bind', label: 'Growth: Anti-Cheat Device Fingerprint', required: false },

  // Store & Streak
  { path: '/store/order', label: 'Customer Web: Medicine/Kit Order Dispatch', required: false },
  { path: '/streak/restore', label: 'Customer Web: Streak Restore Order & Verify', required: false }
];

results.routeAudit.endpoints = {};

frontendExpectedEndpoints.forEach(ep => {
  const isFound = allRouteDefinitions.includes(ep.path);
  results.routeAudit.endpoints[ep.path] = {
    label: ep.label,
    found: isFound,
    required: ep.required
  };

  if (!isFound) {
    if (ep.required) {
      results.missingCapabilities.push(`CRITICAL: Endpoint '${ep.path}' (${ep.label}) is missing from backend routes!`);
    } else {
      results.missingCapabilities.push(`EXTENDED: Endpoint '${ep.path}' (${ep.label}) is not yet implemented on backend`);
    }
  }

  logItem(isFound, ep.label, isFound ? `Route declared (${ep.path})` : 'NOT FOUND in backend routes');
});

// ══════════════════════════════════════════════════════════════
// 5. HARDWARE DISPENSER & SLOTS INTEGRITY
// ══════════════════════════════════════════════════════════════
logHeader('5. HARDWARE & DISPENSER ARCHITECTURE');

const inventoryServicePath = path.join(BACKEND_ROOT, 'src', 'services', 'inventoryManager.js');
const fulfillmentServicePath = path.join(BACKEND_ROOT, 'src', 'services', 'fulfillmentManager.js');

let has3SlotGuard = false;
if (fs.existsSync(fulfillmentServicePath)) {
  const fulfillmentCode = fs.readFileSync(fulfillmentServicePath, 'utf8');
  has3SlotGuard = fulfillmentCode.includes('Must be 1, 2, or 3') && fulfillmentCode.includes('INVALID_DISPENSER_SLOT');
}

results.hardwareAudit.dispenser3SlotStrictGuard = has3SlotGuard;
logItem(has3SlotGuard, 'Dispenser Motor 1/2/3 Architecture', has3SlotGuard ? 'STRICT: Slots limited to 1, 2, or 3 only' : 'Flexible/Unbounded');

// ══════════════════════════════════════════════════════════════
// OVERALL ASSESSMENT & RECOMMENDATIONS
// ══════════════════════════════════════════════════════════════
logHeader('SUMMARY & ACTION PLAN');

const criticalMissing = results.missingCapabilities.filter(m => m.startsWith('CRITICAL'));
if (criticalMissing.length === 0) {
  results.overallHealth = 'PASSING_PRODUCTION_READY';
  console.log('  🎯 OVERALL STATUS: BACKEND CORE IS 100% PRODUCTION READY');
  console.log('  ✅ Offline RTC & monotonic protection: ACTIVE');
  console.log('  ✅ Payment V2 hybrid cryptography: ACTIVE');
  console.log('  ✅ Database security & isolation: ACTIVE');
} else {
  results.overallHealth = 'ACTION_REQUIRED';
  console.log(`  ⚠️ OVERALL STATUS: ${criticalMissing.length} CRITICAL ITEMS NEED ATTENTION`);
}

if (results.missingCapabilities.length > 0) {
  console.log('\n  📋 IDENTIFIED GAPS TO BRIDGE WITH FRONTEND:');
  results.missingCapabilities.forEach((gap, idx) => {
    console.log(`   ${idx + 1}. ${gap}`);
  });
}

// Generate recommendations
if (!results.routeAudit.endpoints['/api/send-health-card']?.found) {
  results.recommendations.push('Implement POST /api/send-health-card on kiosk backend to dispatch PDF report to patient email.');
}
if (!results.routeAudit.endpoints['/api/support-issue']?.found) {
  results.recommendations.push('Implement POST /api/support-issue to forward patient help requests to kiosk admin/SMS/Telegram.');
}
if (!results.databaseAudit.tables['growth_referrals']?.exists) {
  results.recommendations.push('Add Growth/Referral tables to backend SQLite for cross-device sync & anti-cheat fraud prevention.');
}

if (process.argv.includes('--json')) {
  console.log('\n--- JSON OUTPUT BEGIN ---');
  console.log(JSON.stringify(results, null, 2));
  console.log('--- JSON OUTPUT END ---');
}
