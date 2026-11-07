import express from 'express';
import { createV2RateLimiter } from './paymentV2Routes.js';

export function createPushNotificationRouter(pushService) {
  const router = express.Router();
  const subscribeLimiter = createV2RateLimiter({ windowMs: 60_000, max: 30 });
  const testLimiter = createV2RateLimiter({ windowMs: 60_000, max: 5 });

  router.get('/vapid-public-key', (_req, res) => {
    const publicKey = pushService.getPublicKey();
    if (!publicKey) {
      return res.status(503).json({ ok: false, code: 'PUSH_NOT_CONFIGURED' });
    }
    return res.set('Cache-Control', 'no-store').json({ ok: true, publicKey });
  });

  router.get('/health', (_req, res) => {
    const health = pushService.health();
    return res
      .set('Cache-Control', 'no-store')
      .status(health.status === 'healthy' ? 200 : 503)
      .json(health);
  });

  router.post('/subscribe', subscribeLimiter, (req, res) => {
    try {
      const result = pushService.registerSubscription(req.body || {});
      return res.status(200).json(result);
    } catch (error) {
      const status = error.code === 'PUSH_NOT_CONFIGURED' ? 503 : 400;
      return res.status(status).json({
        ok: false,
        code: error.code || 'PUSH_SUBSCRIBE_FAILED',
        message: error.message
      });
    }
  });

  router.post('/test', testLimiter, async (req, res) => {
    try {
      const result = await pushService.sendTest(req.body?.subscription);
      return res.status(result.ok ? 200 : result.expired ? 410 : 502).json(result);
    } catch (error) {
      const status = error.code === 'SUBSCRIPTION_NOT_REGISTERED' ? 404 : 400;
      return res.status(status).json({
        ok: false,
        code: error.code || 'PUSH_TEST_FAILED',
        message: error.message
      });
    }
  });

  return router;
}

export default createPushNotificationRouter;
