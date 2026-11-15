/**
 * OAuth 2.0 for the connector: dynamic client registration (stateless, signed client ids), authorization
 * code + PKCE gated by the admin secret, token and refresh. Moved out of server.ts as is; behaviour,
 * limits and messages are unchanged. createOAuth takes the three settings it needs and returns the handlers.
 */
import * as crypto from 'node:crypto';
import { safeEqual, base64url, signJwt, verifyJwt } from './jwt';
import { clientIp, makeRateLimiter, sendJson, readBody, escapeHtml, PayloadTooLargeError, MAX_BODY_BYTES } from './http-util';

export function createOAuth(cfg: { baseUrl: string; adminSecret: string | undefined; jwtSecret: string | undefined }) {
  const BASE_URL = cfg.baseUrl;
  const ADMIN_SECRET = cfg.adminSecret;
  const JWT_SECRET = cfg.jwtSecret as string;

  // In-memory store for OAuth authorization codes (short-lived, single-use).
  // Fine for a single-instance bridge server; not meant to scale horizontally.
  const pendingCodes = new Map(); // code -> { expiresAt, codeChallenge, codeChallengeMethod, clientId }

  const ALLOWED_REDIRECT_HOSTS = new Set(
    (process.env.ALLOWED_REDIRECT_HOSTS || 'claude.ai')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const ACCESS_TOKEN_TTL_S = 60 * 60; // 1 hour
  const REFRESH_TOKEN_TTL_S = 60 * 60 * 24 * 30; // 30 days

  function issueTokens() {
    return {
      access_token: signJwt({ sub: 'lily-mcp-user', typ: 'access' }, JWT_SECRET, ACCESS_TOKEN_TTL_S),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: signJwt({ sub: 'lily-mcp-user', typ: 'refresh' }, JWT_SECRET, REFRESH_TOKEN_TTL_S),
    };
  }

  // ---------------------------------------------------------------------------
  // Stateless OAuth client IDs (RFC 7591 dynamic registration)
  //
  // The client_id embeds the registered redirect URIs and is HMAC-signed, so we
  // can validate redirect_uri on /authorize without keeping registrations in
  // memory (which a free-tier restart would wipe out).
  // ---------------------------------------------------------------------------

  function signClientPayload(p64) {
    return crypto.createHmac('sha256', JWT_SECRET).update(`client.${p64}`).digest('base64url');
  }

  function makeClientId(redirectUris) {
    const p64 = base64url(JSON.stringify({ ru: redirectUris }));
    return `${p64}.${signClientPayload(p64)}`;
  }

  function parseClientId(clientId) {
    try {
      const parts = String(clientId).split('.');
      if (parts.length !== 2) return null;
      const [p64, sig] = parts;
      if (!p64 || !sig || !safeEqual(sig, signClientPayload(p64))) return null;
      const p = JSON.parse(Buffer.from(p64, 'base64url').toString('utf8'));
      return p && Array.isArray(p.ru) ? { redirectUris: p.ru } : null;
    } catch (e) {
      return null;
    }
  }

  // Returns an error string, or null if the client + redirect URI are valid.
  function validateAuthRequest(clientId, redirectUri) {
    const client = parseClientId(clientId);
    if (!client) return 'unknown_client';
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return 'redirect_uri_mismatch';
    return null;
  }

  // PKCE is mandatory and S256-only: this is a public client (no client secret),
  // so PKCE is what stops a stolen authorization code from being redeemed.
  function validatePkceParams(codeChallenge, method) {
    if (!codeChallenge) return 'code_challenge_required';
    if (method !== 'S256') return 'code_challenge_method_must_be_S256';
    return null;
  }

  function isAcceptableRedirectUri(uri) {
    try {
      const u = new URL(uri);
      if (u.protocol === 'http:') {
        // Loopback http is always fine — only reachable from this machine,
        // used by native/desktop MCP clients during local development.
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      }
      if (u.protocol !== 'https:') return false;
      // https must target an explicitly allowed host (or a subdomain of one).
      // This is what stops a stranger from registering a client_id whose
      // redirect_uri points at a domain they control (consent phishing): even
      // with a valid client_id + PKCE, /authorize will never hand out a code
      // for a redirect host outside this list.
      const host = u.hostname.toLowerCase();
      for (const allowed of ALLOWED_REDIRECT_HOSTS) {
        if (host === allowed || host.endsWith(`.${allowed}`)) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // /authorize: keyed on wrong-secret attempts (existing behavior).
  const authorizeLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 5, maxGlobal: 20 });
  // /register and /token: no "wrong password" concept, so every call counts —
  // these just cap raw request volume per IP to blunt automated abuse/spam.
  const registerLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 20, maxGlobal: 100 });
  const tokenLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 30, maxGlobal: 150 });
  function handleAuthServerMetadata(req, res) {
    sendJson(res, 200, {
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/authorize`,
      token_endpoint: `${BASE_URL}/token`,
      registration_endpoint: `${BASE_URL}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
  }

  // RFC 9728 - tells an MCP client which authorization server protects this
  // resource. Claude fetches this (per the URL in the WWW-Authenticate header
  // on a 401 from /mcp) before it knows where to send the user to sign in.
  function handleProtectedResourceMetadata(req, res) {
    sendJson(res, 200, {
      resource: `${BASE_URL}/mcp`,
      authorization_servers: [BASE_URL],
    });
  }

  // RFC 7591 - Dynamic Client Registration. claude.ai has no pre-shared
  // client_id for a server it's never seen before, so it registers itself
  // here first. The returned client_id is a signed token that embeds the
  // registered redirect URIs (see makeClientId); no client_secret is issued
  // since this is a public client using PKCE.
  async function handleRegister(req, res) {
    const ip = clientIp(req);
    if (registerLimiter.lockedOut(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(registerLimiter.windowMs / 1000)) });
      res.end(JSON.stringify({ error: 'too_many_requests' }));
      return;
    }
    registerLimiter.recordFailure(ip); // every call counts toward the cap, not just failures

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, 400, { error: 'invalid_client_metadata' });
      return;
    }

    const uris = payload && payload.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.length > 10 ||
      !uris.every((u) => typeof u === 'string' && isAcceptableRedirectUri(u))
    ) {
      sendJson(res, 400, {
        error: 'invalid_redirect_uri',
        error_description: `redirect_uris must be 1-10 https URLs on an allowed host (${[...ALLOWED_REDIRECT_HOSTS].join(', ')}), or loopback http for local clients.`,
      });
      return;
    }

    sendJson(res, 201, {
      client_id: makeClientId(uris),
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  function handleAuthorizeGet(req, res, query) {
    const redirectUri = query.get('redirect_uri') || '';
    const state = query.get('state') || '';
    const clientId = query.get('client_id') || '';
    const codeChallenge = query.get('code_challenge') || '';
    const codeChallengeMethod = query.get('code_challenge_method') || '';

    // Reject bad requests before ever showing the password form.
    const invalid = validateAuthRequest(clientId, redirectUri) || validatePkceParams(codeChallenge, codeChallengeMethod);
    if (invalid) {
      sendJson(res, 400, { error: 'invalid_request', error_description: invalid });
      return;
    }

    // Safe: redirectUri already passed validateAuthRequest above, which
    // confirms it's one of the client's registered (and host-allowlisted)
    // URIs, so `new URL()` here won't throw and won't reflect anything
    // outside what /register already accepted.
    const redirectHost = new URL(redirectUri).host;

    const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>lily-github-mcp-bridge</title>
  <style>body{font-family:system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 16px}
  input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box}
  button{padding:10px 16px;cursor:pointer}
  .dest{background:#f3f4f6;border:1px solid #d1d5db;border-radius:8px;padding:10px 12px;margin:16px 0;font-size:0.9rem;word-break:break-all}
  .dest b{display:block;margin-bottom:4px;font-size:1rem}
  .dest span{color:#6b7280}</style></head>
  <body>
  <h2>Authorize MCP access</h2>
  <p>An application is requesting access to this bridge. Check the destination below before entering the admin secret — if it's not what you expect, close this page.</p>
  <div class="dest"><b>${escapeHtml(redirectHost)}</b><span>${escapeHtml(redirectUri)}</span></div>
  <form method="POST" action="/authorize">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
    <input type="password" name="secret" placeholder="Admin secret" required autofocus>
    <button type="submit">Authorize</button>
  </form>
  </body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      // The password form must never be framed (clickjacking) or cached.
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  async function handleAuthorizePost(req, res) {
    const ip = clientIp(req);
    if (authorizeLimiter.lockedOut(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(authorizeLimiter.windowMs / 1000)) });
      res.end(JSON.stringify({ error: 'too_many_attempts' }));
      return;
    }

    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const secret = params.get('secret') || '';
    const redirectUri = params.get('redirect_uri') || '';
    const state = params.get('state') || '';
    const clientId = params.get('client_id') || '';
    const codeChallenge = params.get('code_challenge') || '';
    const codeChallengeMethod = params.get('code_challenge_method') || '';

    const invalid = validateAuthRequest(clientId, redirectUri) || validatePkceParams(codeChallenge, codeChallengeMethod);
    if (invalid) {
      sendJson(res, 400, { error: 'invalid_request', error_description: invalid });
      return;
    }

    if (!safeEqual(secret, ADMIN_SECRET)) {
      authorizeLimiter.recordFailure(ip);
      sendJson(res, 401, { error: 'invalid_secret' });
      return;
    }
    authorizeLimiter.clear(ip);

    const code = crypto.randomBytes(24).toString('hex');
    pendingCodes.set(code, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      codeChallenge,
      codeChallengeMethod,
      clientId,
      redirectUri,
    });

    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    if (state) location.searchParams.set('state', state);

    res.writeHead(302, { Location: location.toString() });
    res.end();
  }

  function verifyPkce(entry, codeVerifier) {
    // PKCE is mandatory (enforced when the code is issued); a code without a
    // challenge, or with any method but S256, is never redeemable.
    if (!entry.codeChallenge || entry.codeChallengeMethod !== 'S256') return false;
    if (!codeVerifier) return false;
    const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return safeEqual(hash, entry.codeChallenge);
  }

  // Token responses must not be cached (RFC 6749 section 5.1).
  const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

  async function handleToken(req, res) {
    const ip = clientIp(req);
    if (tokenLimiter.lockedOut(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(tokenLimiter.windowMs / 1000)) });
      res.end(JSON.stringify({ error: 'too_many_requests' }));
      return;
    }
    tokenLimiter.recordFailure(ip); // every call counts toward the cap, not just failures

    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const grantType = params.get('grant_type');

    if (grantType === 'refresh_token') {
      const claims = verifyJwt(params.get('refresh_token') || '', JWT_SECRET);
      if (!claims || claims.typ !== 'refresh') {
        sendJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      sendJson(res, 200, issueTokens(), NO_STORE);
      return;
    }

    if (grantType !== 'authorization_code') {
      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    const code = params.get('code');
    const entry = code && pendingCodes.get(code);
    if (!entry || Date.now() > entry.expiresAt) {
      sendJson(res, 400, { error: 'invalid_grant' });
      return;
    }

    // The code is bound to the client and redirect URI it was issued for
    // (RFC 6749 section 4.1.3); a code redeemed for any other pair is refused.
    if (params.get('client_id') !== entry.clientId || params.get('redirect_uri') !== entry.redirectUri) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'client_id or redirect_uri does not match the authorization request' });
      return;
    }

    const codeVerifier = params.get('code_verifier');
    if (!verifyPkce(entry, codeVerifier)) {
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }

    pendingCodes.delete(code); // single-use

    sendJson(res, 200, issueTokens(), NO_STORE);
  }

  return { issueTokens, handleAuthServerMetadata, handleProtectedResourceMetadata, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken };
}
