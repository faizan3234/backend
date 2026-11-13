import { sameSecret } from './growthIdentity.js';

// Vercel requests share an egress IP. Trust the hashed client address only when
// supplied by our authenticated proxy; arbitrary browser headers cannot reset it.
export function createGrowthRateLimiter({ env = process.env, max = 120, clock = Date.now } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const forwarded = req.get('X-Reliv-Growth-Client');
    const trusted = env.GROWTH_PROXY_SECRET && sameSecret(req.get('X-Reliv-Growth-Proxy-Key'), env.GROWTH_PROXY_SECRET);
    const key = trusted && /^[a-f0-9]{64}$/.test(forwarded || '') ? forwarded : req.ip;
    const now = clock();
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 20000) {
        for (const [id, entry] of buckets) if (entry.until <= now) buckets.delete(id);
        if (buckets.size >= 20000) return res.status(503).json({ok:false,error:'Community service is busy. Please retry shortly.'});
      }
      bucket = {count:0,until:now+60000};
      buckets.set(key,bucket);
    }
    if (++bucket.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.until-now)/1000))));
      return res.status(429).json({ok:false,error:'Too many attempts. Please wait a minute and retry.'});
    }
    next();
  };
}
