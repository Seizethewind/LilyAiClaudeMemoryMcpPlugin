/** Constant-time compare and a tiny HS256 JWT, no external dependencies. */
import * as crypto from 'node:crypto';

// Constant-time string comparison. Both sides are hashed first so the inputs
// are always the same length (timingSafeEqual throws on length mismatch and
// an early length check would leak the secret's length).
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Tiny JWT (HS256) implementation, no external deps
// ---------------------------------------------------------------------------

export function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function signJwt(payload, secret, expiresInSeconds) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${headerB64}.${payloadB64}.${signature}`;
}

// Returns the payload for a valid, unexpired token, or null for anything
// else (malformed, bad signature, expired). Never throws.
export function verifyJwt(token, secret) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signature] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    if (!safeEqual(signature, expected)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
