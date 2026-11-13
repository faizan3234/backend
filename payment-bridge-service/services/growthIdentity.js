import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

export const growthError = (status, message) => Object.assign(new Error(message), { status });
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export function sameSecret(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length > 0 &&
    timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}

// No decoded JWT or email string is treated as authentication. Keys are fetched
// only from Google's fixed HTTPS endpoint; caller-supplied URLs are never used.
export function createGoogleVerifier({ clientId, fetcher = fetch, clock = Date.now } = {}) {
  let cached = [], expires = 0, pending;
  return async token => {
    if (!clientId) throw growthError(503, 'Google verification is not configured.');
    if (typeof token !== 'string' || token.length > 12000) throw growthError(401, 'Sign in with Google again.');
    let header, claims, parts;
    try {
      parts = token.split('.');
      if (parts.length !== 3) throw Error();
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch { throw growthError(401, 'Invalid Google credential.'); }
    const now = clock();
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string' ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        claims.aud !== clientId || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
        !Number.isFinite(claims.iat) || claims.iat * 1000 > now + 60000 ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 ||
        claims.email_verified !== true || typeof claims.email !== 'string') {
      throw growthError(401, 'Google credential could not be verified.');
    }
    if (now >= expires) {
      pending ||= (async () => {
        const response = await fetcher('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw growthError(503, 'Google verification is temporarily unavailable.');
        const data = await response.json();
        if (!Array.isArray(data.keys)) throw growthError(503, 'Google verification is temporarily unavailable.');
        cached = data.keys;
        const maxAge = Number(response.headers?.get?.('cache-control')?.match(/max-age=(\d+)/)?.[1] || 300);
        expires = clock() + Math.min(maxAge, 3600) * 1000;
      })().finally(() => { pending = undefined; });
      await pending;
    }
    const jwk = cached.find(key => key.kid === header.kid && key.kty === 'RSA');
    if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
      throw growthError(401, 'Google signature could not be verified.');
    }
    return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name || '' };
  };
}
