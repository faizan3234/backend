import express from 'express';

// These older routes trusted browser IDs, invented payment/order confirmations,
// and used a second leaderboard. Keep explicit errors for outdated clients.
export function createLegacyCustomerRouter({ local = false } = {}) {
  const router = express.Router();
  router.use(['/api/growth', '/growth', '/api/admin/leaderboard/reset'], (_req, res) =>
    res.status(local ? 503 : 410).set('Cache-Control', 'no-store').json({
      ok: false,
      code: local ? 'COMMUNITY_REQUIRES_CLOUD' : 'CLIENT_UPDATE_REQUIRED',
      error: local ? 'Community referrals use the online Reliv app. The offline kiosk does not maintain a separate ranking.' : 'Please reload the Reliv app to use the current referral service.'
    }));
  router.use(['/api/store', '/store', '/api/streak', '/streak', '/api/goal', '/goal'], (_req, res) =>
    res.status(503).set('Cache-Control', 'no-store').json({
      ok: false,
      code: 'SERVICE_NOT_ENABLED',
      error: 'This service is not enabled. No order, payment, refund or dispatch has been confirmed.'
    }));
  return router;
}
