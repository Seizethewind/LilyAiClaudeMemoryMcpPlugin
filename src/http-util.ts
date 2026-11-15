/** Small HTTP helpers shared by the OAuth and MCP handlers: JSON replies, bounded body reads, client IP, rate limiter. */

export function clientIp(req) {
  // Behind a reverse proxy the rightmost X-Forwarded-For entry is the one the
  // proxy itself appended; earlier entries can be forged by the client.
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function makeRateLimiter({ windowMs, maxPerIp, maxGlobal }) {
  const perIp = new Map(); // ip -> [timestamps]
  let global: number[] = [];

  function recent(list) {
    const cutoff = Date.now() - windowMs;
    return list.filter((t) => t > cutoff);
  }

  // Periodically drop stale entries so the map can't grow without bound.
  setInterval(() => {
    for (const [ip, list] of perIp) {
      const r = recent(list);
      if (r.length) perIp.set(ip, r);
      else perIp.delete(ip);
    }
  }, windowMs).unref();

  return {
    lockedOut(ip) {
      global = recent(global);
      const mine = recent(perIp.get(ip) || []);
      if (mine.length) perIp.set(ip, mine);
      else perIp.delete(ip);
      return mine.length >= maxPerIp || global.length >= maxGlobal;
    },
    recordFailure(ip) {
      const now = Date.now();
      perIp.set(ip, [...recent(perIp.get(ip) || []), now]);
      global.push(now);
    },
    clear(ip) {
      perIp.delete(ip);
    },
    windowMs,
  };
}

export function sendJson(res, status, obj, extraHeaders?) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

// Applies to every POST body this server reads, including the unauthenticated
// /register, /authorize, and /token endpoints, so a flood of oversized
// requests can't grow memory unbounded. None of our real payloads (OAuth
// form posts, MCP tool calls, file contents for push_files) need anywhere
// near this much; it's a generous ceiling, not a working limit.
export const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

export class PayloadTooLargeError extends Error {}

export function readBody(req) {
  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new PayloadTooLargeError('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function getBearerToken(req) {
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c: string) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]));
}
