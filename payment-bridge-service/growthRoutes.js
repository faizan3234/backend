import express from 'express';
import { createGrowthRateLimiter } from './services/growthRateLimit.js';
import { createGoogleVerifier, sameSecret, growthError } from './services/growthIdentity.js';
import { GrowthService } from './services/growthService.js';

export function createGrowthRouter({ db, env = process.env, clock, verifyGoogle } = {}) {
  const router = express.Router();
  const service = new GrowthService({ db, clock });
  const google = verifyGoogle || createGoogleVerifier({ clientId: env.GOOGLE_CLIENT_ID });
  const rate = createGrowthRateLimiter({ env, max: 120 });
  const adminRate = createGrowthRateLimiter({ env, max: 10 });
  router.use(rate, (_req, res, next) => { res.set('Cache-Control','private, no-store'); next(); });
  const token = req => (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const body = req => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || JSON.stringify(req.body).length > 16000) throw growthError(400,'Invalid request.');
    return req.body;
  };
  const run = fn => async (req,res) => {
    try { return res.json(await fn(req)); }
    catch(error) { return res.status(error.status || 503).json({ok:false,error:error.status?error.message:'Referral service is temporarily unavailable. Please retry.'}); }
  };
  router.get('/referrals', run(req => {
    const action=req.query.action || 'leaderboard';
    if(action==='leaderboard') return service.leaderboard(req.query.period);
    if(action==='verify') { const member=service.member(req.query.refCode); return {ok:true,verified:true,referrer:{referralCode:member.code,displayName:member.name||`Member ${member.id}`}}; }
    if(action==='stats') return {ok:true,...service.snapshot(service.authenticate(token(req)).id)};
    throw growthError(400,'Unknown referral action.');
  }));
  router.post('/referrals', run(async req => {
    const data=body(req), action=req.query.action;
    if(action==='register') return service.register(data.registrationKey);
    const user=service.authenticate(token(req));
    if(action==='claim') return service.claim(user,data.refCode);
    if(action==='track') return service.track(user,data.refCode);
    if(action==='profile') return service.profile(user,data);
    if(action==='activity') return service.activity(user,data.kind);
    if(action==='google') return service.linkGoogle(user,await google(data.credential),token(req));
    // No sync_user endpoint: the browser cannot upload scores, Google IDs,
    // eligibility, claimed rewards, or historic days to overwrite the ledger.
    throw growthError(400,'Unknown referral action.');
  }));
  router.post('/analytics', run(req => {
    const data=body(req);return service.signal(service.authenticate(token(req)),data.type,data.platform);
  }));
  const admin = async req => {
    if(!env.GROWTH_ADMIN_PASSKEY || !env.GROWTH_ADMIN_EMAILS) throw growthError(503,'Growth administrator access is not configured.');
    if(!sameSecret(req.get('X-Reliv-Admin-Key'),env.GROWTH_ADMIN_PASSKEY)) throw growthError(403,'Administrator access denied.');
    const identity=await google(token(req));
    const allowed=env.GROWTH_ADMIN_EMAILS.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(!allowed.includes(identity.email))throw growthError(403,'This Google account is not an administrator.');
    return identity;
  };
  router.get('/admin',adminRate,run(async req=>{await admin(req);return service.adminOverview();}));
  router.post('/admin',adminRate,run(async req=>{const identity=await admin(req),data=body(req);return service.decide(data.targetUserId,data.decision,identity.email,data.reason);}));
  return router;
}
