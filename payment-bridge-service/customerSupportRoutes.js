import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createGrowthRateLimiter } from './services/growthRateLimit.js';

// Generic UI issues have their own table. Paid-order complaints retain their
// session-bound evidence in support_cases and must never be overwritten here.
export function createCustomerSupportRouter({ getDb, local = false, requireAdmin } = {}) {
  const router = express.Router();
  const database = () => {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS ui_support_issues (
      case_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
      page TEXT NOT NULL, issue TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    return db;
  };
  router.post('/api/support-issue', createGrowthRateLimiter({ max: 20 }), (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { requestId, page, issue } = req.body || {};
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{32,64}$/i.test(requestId) ||
        typeof page !== 'string' || !page.trim() || page.length > 120 ||
        typeof issue !== 'string' || !issue.trim() || issue.length > 1000) {
      return res.status(400).json({ ok: false, error: 'Choose a problem and retry the report.' });
    }
    const values = [page.trim(), issue.trim()];
    const hash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    try {
      const db = database();
      const result = db.transaction(() => {
        const prior = db.prepare('SELECT * FROM ui_support_issues WHERE request_id=?').get(requestId);
        if (prior) return prior;
        const row = { case_id: `HELP-${randomUUID()}`, request_id: requestId, payload_hash: hash, page: values[0], issue: values[1], created_at: new Date().toISOString() };
        db.prepare('INSERT INTO ui_support_issues VALUES (@case_id,@request_id,@payload_hash,@page,@issue,@created_at)').run(row);
        return row;
      })();
      if (result.payload_hash !== hash) return res.status(409).json({ ok: false, error: 'This report reference was already used. Close the form and submit a new report.' });
      return res.json({ ok: true, saved: true, caseId: result.case_id, notified: false,
        message: local ? 'Saved on this kiosk. Show the reference to staff or contact Reliv support.' : 'Saved to Reliv support records. Contact support with this reference for help.' });
    } catch {
      return res.status(503).json({ ok: false, saved: false, error: 'The report could not be saved. Please contact support directly.' });
    }
  });
  if (requireAdmin) router.get('/api/admin/ui-support-issues', requireAdmin, (_req, res) => {
    try { return res.set('Cache-Control', 'private, no-store').json({ ok: true, issues: database().prepare('SELECT case_id,page,issue,created_at FROM ui_support_issues ORDER BY created_at DESC LIMIT 100').all() }); }
    catch { return res.status(503).json({ ok: false, error: 'Support records unavailable.' }); }
  });
  // Existing paid-report APIs generate and email the signed customer's report.
  // Never expose an unauthenticated arbitrary-recipient HTML/image mail relay.
  router.post('/api/send-health-card', (_req, res) => res.status(410).json({ ok: false, sent: false, queued: false,
    error: 'Open your paid report and use its Email report option. This older card-email endpoint is no longer available.' }));
  if (local) router.post(['/api/weight/reset', '/api/weight/tare'], (_req, res) => res.status(501).json({ ok: false,
    error: 'This route cannot confirm scale calibration. Use the connected scale service or the scale’s zero button.' }));
  return router;
}
