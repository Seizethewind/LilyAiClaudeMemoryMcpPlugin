/**
 * lily-github-mcp-bridge
 *
 * A minimal, zero-dependency, self-hosted MCP server that lets Claude read
 * and WRITE to specific GitHub repositories using a Personal Access Token
 * (PAT) that you control. Built because Anthropic's built-in GitHub
 * connector is read-only for repo contents.
 *
 * - No npm dependencies: uses only Node's built-in http/https/crypto/fs.
 * - OAuth 2.0 (authorization-code style) in front of the MCP endpoint,
 *   gated by an admin secret (MCP_ADMIN_SECRET) you set as an env var.
 *   This satisfies Claude.ai's requirement that custom connectors use OAuth.
 * - Access tokens last 1 hour and are renewed automatically via a
 *   stateless 30-day refresh token, so the connector doesn't need
 *   re-authorizing every hour (and survives server restarts).
 * - The actual GitHub PAT (GITHUB_TOKEN) never leaves this server or touches
 *   Claude / Anthropic infrastructure. It's used only for outbound calls to
 *   api.github.com.
 * - Repo access is restricted to ALLOWED_REPOS (comma-separated "owner/repo"
 *   list, with "owner/*" and "*" wildcards supported) so the bridge can't
 *   touch anything beyond what you intend, even if the PAT itself has
 *   broader scope.
 * - GET /status.html serves a small static status page (no auth required,
 *   read-only, doesn't expose repo contents) that pings /health.
 *
 * Required env vars:
 *   GITHUB_TOKEN     - a GitHub PAT (fine-grained, scoped narrowly is best)
 *   MCP_ADMIN_SECRET - a long random string; acts as the password gating
 *                      the OAuth /authorize page
 *   MCP_BASE_URL     - the public HTTPS URL this server is reachable at,
 *                      e.g. https://your-domain.com  (no trailing slash)
 *   ALLOWED_REPOS    - comma-separated "owner/repo" list, e.g.
 *                      "UmakraftCircle/DmLilyAi". Also accepts "owner/*"
 *                      (every repo under that owner) or "*" (every repo the
 *                      token can reach).
 *
 * Optional env vars:
 *   MCP_JWT_SECRET   - a separate long random string used to sign tokens and
 *                      client IDs. Recommended, so the login password and the
 *                      signing key aren't the same value. Falls back to
 *                      MCP_ADMIN_SECRET if unset. Changing it invalidates
 *                      all issued tokens (you'll need to reconnect).
 *   ALLOWED_REDIRECT_HOSTS - comma-separated list of hostnames (or parent
 *                      domains) that an OAuth client is allowed to register
 *                      a redirect_uri against, e.g. "claude.ai". Defaults to
 *                      "claude.ai". Loopback (localhost/127.0.0.1) is always
 *                      allowed for native/desktop MCP clients regardless of
 *                      this setting. This exists so a stranger can't register
 *                      a client_id pointing at their own domain and trick you
 *                      into authorizing a token that gets redirected to them
 *                      (consent phishing) — the /authorize page only ever
 *                      hands out a code to a host on this list.
 *
 * Run:
 *   GITHUB_TOKEN=ghp_xxx MCP_ADMIN_SECRET=xxx MCP_BASE_URL=https://your.host \
 *   ALLOWED_REPOS=UmakraftCircle/DmLilyAi node server.js
 *
 * Then in claude.ai: Settings -> Connectors -> Add custom connector
 *   URL: https://your.host/mcp
 */

'use strict';

import { MemoryStore, buildMemoryTools, MEMORY_INSTRUCTIONS } from './memory';
import { openTurso } from './db';
import { createMemoryAdmin } from './memory-admin';
import { buildGuideTools, PROMPTS, getPrompt, GUIDE_HINT } from './guide';
import { loadSkills, buildSkillTools, skillsHint } from './skills';
import { buildGatewayTools, visibleTools, unwrap, toolMode, GATEWAY_ANNOTATIONS, GATEWAY_HINT } from './gateway';
import { safeEqual, base64url, signJwt, verifyJwt } from './jwt';
import { clientIp, makeRateLimiter, sendJson, readBody, getBearerToken, escapeHtml, PayloadTooLargeError, MAX_BODY_BYTES } from './http-util';
import { createOAuth } from './oauth';
import { createMcpHandler } from './mcp-handler';
import { TOOL_ANNOTATIONS } from './annotations';
import { createGithubCore } from './github-core';
import { callGuardFromEnv, auditLine } from './guard';
import { parseApiKeys, authenticateApiKey } from './apikeys';
import { buildCoreTools } from './core-tools';
import { buildSandboxTools, SANDBOX_ANNOTATIONS, SANDBOX_HINT } from './sandbox';
import { buildTavilyTools, TAVILY_ANNOTATIONS, TAVILY_HINT } from './tavily';
import { buildGithubTools, GITHUB_TOOL_ANNOTATIONS, GITHUB_HINT } from './github-tools';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3232;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_SECRET = process.env.MCP_ADMIN_SECRET;
const JWT_SECRET = process.env.MCP_JWT_SECRET || ADMIN_SECRET;
const BASE_URL = (process.env.MCP_BASE_URL || '').replace(/\/$/, '');
const ALLOWED_REPOS = new Set<string>(
  (process.env.ALLOWED_REPOS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
// Repos Claude may WRITE to (commit, delete, create branches). Same syntax as
// ALLOWED_REPOS. When unset it falls back to ALLOWED_REPOS (the old behaviour),
// so existing deployments keep working; set it to narrow write access below
// read access.
const WRITE_REPOS_RAW = (process.env.WRITE_REPOS || '').trim();
const WRITE_REPOS = WRITE_REPOS_RAW
  ? new Set<string>(
      WRITE_REPOS_RAW.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  : ALLOWED_REPOS;
// By default writes to a repo's default branch are refused, so changes arrive
// on a branch and get reviewed (e.g. via a pull request).
const ALLOW_DEFAULT_BRANCH_WRITES = process.env.ALLOW_DEFAULT_BRANCH_WRITES === 'true';
if (!GITHUB_TOKEN) {
  console.error('FATAL: GITHUB_TOKEN env var is required.');
  process.exit(1);
}
if (!ADMIN_SECRET) {
  console.error('FATAL: MCP_ADMIN_SECRET env var is required.');
  process.exit(1);
}
if (!BASE_URL) {
  console.error('FATAL: MCP_BASE_URL env var is required (e.g. https://your.host).');
  process.exit(1);
}
if (ALLOWED_REPOS.size === 0) {
  console.error('FATAL: ALLOWED_REPOS env var is required, e.g. "owner/repo,owner/repo2".');
  process.exit(1);
}
if (ALLOWED_REPOS.has('*')) {
  console.warn('WARN: ALLOWED_REPOS="*" lets Claude read every repo the token can reach. Prefer "owner/*" or an explicit list.');
}
if (WRITE_REPOS.has('*')) {
  console.warn('WARN: write access covers every repo the token can reach. Set WRITE_REPOS to a narrow list (default branches stay protected unless ALLOW_DEFAULT_BRANCH_WRITES=true).');
}
if (ALLOW_DEFAULT_BRANCH_WRITES) {
  console.warn('WARN: ALLOW_DEFAULT_BRANCH_WRITES=true: Claude can commit straight to default branches.');
}
if (!process.env.MCP_JWT_SECRET) {
  console.warn('WARN: MCP_JWT_SECRET is not set; signing tokens with MCP_ADMIN_SECRET. Set a separate value for better isolation.');
}

// ---------------------------------------------------------------------------
// Static status page (read-only, no auth, doesn't expose repo contents)
// ---------------------------------------------------------------------------

let STATUS_HTML = null;
try {
  STATUS_HTML = fs.readFileSync(path.join(__dirname, __dirname.endsWith('dist') || __dirname.endsWith('src') ? '..' : '.', 'status.html'), 'utf8');
} catch (e) {
  console.warn('WARN: status.html not found next to server.js; /status.html will 404.');
}

// ---------------------------------------------------------------------------
// Small crypto helpers
// ---------------------------------------------------------------------------

const { handleAuthServerMetadata, handleProtectedResourceMetadata, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken } = createOAuth({
  baseUrl: BASE_URL,
  adminSecret: ADMIN_SECRET,
  jwtSecret: JWT_SECRET,
});

// ---------------------------------------------------------------------------
// Rate limiting for unauthenticated POST endpoints (/authorize, /register,
// /token). Each endpoint gets its own bucket (separate per-IP and global
// counters) via makeRateLimiter, so hammering one doesn't lock out another.
// In-memory only: counters reset on a process restart (e.g. a Render
// free-tier spin-down/up cycle). That's an accepted tradeoff for a
// single-instance bridge with no external store — it bounds abuse within a
// running process without adding a database dependency.
// ---------------------------------------------------------------------------

// /admin/memory sign-in: wrong-secret attempts, same budget as /authorize.
const adminLimiter = makeRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 5, maxGlobal: 20 });

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const githubCore = createGithubCore({
  token: GITHUB_TOKEN,
  allowedRepos: ALLOWED_REPOS,
  writeRepos: WRITE_REPOS,
  allowDefaultBranchWrites: ALLOW_DEFAULT_BRANCH_WRITES,
});
const { githubRequest, assertRepoAllowed, assertWriteAllowed, encodePath, downloadTail } = githubCore;

const TOOLS: any[] = buildCoreTools(githubCore);
const CORE_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const callGuard = callGuardFromEnv();
const { keys: API_KEYS, warnings: API_KEY_WARNINGS } = parseApiKeys(process.env.MCP_API_KEYS);
for (const w of API_KEY_WARNINGS) console.warn(`[api-keys] ${w}`);
if (API_KEYS.length) console.log(`[api-keys] ${API_KEYS.length} access key(s) enabled: ${API_KEYS.map((k) => `${k.label} (${k.scope})`).join(', ')}.`);

// On-demand repo breakdown playbook (no analysis runs here; Claude does it).
TOOLS.push(...buildGuideTools());
const SKILLS = loadSkills();
TOOLS.push(...buildSkillTools(SKILLS));
const TOOL_MODE = toolMode();
if (TOOL_MODE === 'gateway') TOOLS.push(...buildGatewayTools(() => TOOLS, () => TOOL_ANNOTATIONS));
console.log(`[tools] mode=${TOOL_MODE}${TOOL_MODE === 'gateway' ? ' (basic tools listed, the rest via find_tools/use_tool/use_write_tool)' : ' (all tools listed)'}.`);

// Pull requests, issues and Actions. Reads follow ALLOWED_REPOS, writes follow WRITE_REPOS.
// Merging, approving and dispatching arbitrary workflows are deliberately not offered.
const GITHUB_TOOLS = buildGithubTools({
  request: githubRequest,
  assertRead: assertRepoAllowed,
  assertWrite: assertWriteAllowed,
  download: downloadTail,
});
TOOLS.push(...GITHUB_TOOLS);

// PandaStack microVM sandboxes (browser/Playwright, exec, files). Only registered
// when PANDASTACK_API_KEY is set; otherwise this adds nothing.
// Tavily web search (optional, TAVILY_API_KEY, several keys rotate). When it is on, it owns web_search and
// the sandbox's browser-scraping web_search steps aside; the sandbox's web_fetch (JavaScript pages) stays.
const TAVILY_TOOLS = buildTavilyTools();
TOOLS.push(...TAVILY_TOOLS);
if (TAVILY_TOOLS.length) console.log('[tavily] web search enabled.');
else console.warn('[tavily] TAVILY_API_KEY not set — using the sandbox browser for web_search (if PandaStack is configured).');
const SANDBOX_TOOLS = buildSandboxTools().filter((t) => !(TAVILY_TOOLS.length && t.name === 'web_search'));
TOOLS.push(...SANDBOX_TOOLS);
if (SANDBOX_TOOLS.length) console.log(`[sandbox] PandaStack tools enabled (${SANDBOX_TOOLS.length}).`);
else console.warn('[sandbox] PANDASTACK_API_KEY not set — sandbox tools disabled.');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OAuth 2.0 endpoints (authorization code flow, gated by MCP_ADMIN_SECRET)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP JSON-RPC endpoint
// ---------------------------------------------------------------------------

const handleMcp = createMcpHandler({
  jwtSecret: JWT_SECRET,
  baseUrl: BASE_URL,
  apiKeys: API_KEYS,
  tools: TOOLS,
  annotations: TOOL_ANNOTATIONS,
  toolMode: TOOL_MODE,
  callGuard,
  isGithubTool: (name) => CORE_TOOL_NAMES.has(name) || GITHUB_TOOLS.some((t) => t.name === name),
  instructions: () =>
    [
      memoryStore ? MEMORY_INSTRUCTIONS : '',
      TOOL_MODE === 'gateway' ? GATEWAY_HINT : '',
      GUIDE_HINT,
      skillsHint(SKILLS),
      GITHUB_HINT,
      TAVILY_TOOLS.length ? TAVILY_HINT : '',
      SANDBOX_TOOLS.length ? SANDBOX_HINT : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

// Server-wide memory operations (wipe all, erase trash, unlock) live on this
// page only; no MCP tool exposes them. Needs the admin secret, typed by a person.
const memoryAdmin = createMemoryAdmin({
  store: () => memoryStore,
  checkSecret: (candidate) => !!ADMIN_SECRET && safeEqual(candidate, ADMIN_SECRET),
  safeEqual,
  sign: (payload, seconds) => signJwt(payload, JWT_SECRET, seconds),
  verify: (token) => verifyJwt(token, JWT_SECRET),
  readBody,
  clientIp,
  limiter: adminLimiter,
  secureCookies: BASE_URL.startsWith('https://'),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/health' && req.method === 'GET') {
      // CORS enabled so the /status.html page (or any browser page) can read
      // this. It returns no repo data or secrets, so an open CORS policy
      // here is safe.
      sendJson(res, 200, { status: 'ok' }, { 'Access-Control-Allow-Origin': '*' });
      return;
    }
    if ((url.pathname === '/' || url.pathname === '/status.html') && req.method === 'GET') {
      if (!STATUS_HTML) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(STATUS_HTML) });
      res.end(STATUS_HTML);
      return;
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      handleAuthServerMetadata(req, res);
      return;
    }
    if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      handleProtectedResourceMetadata(req, res);
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      await handleRegister(req, res);
      return;
    }
    if (url.pathname === '/authorize' && req.method === 'GET') {
      handleAuthorizeGet(req, res, url.searchParams);
      return;
    }
    if (url.pathname === '/authorize' && req.method === 'POST') {
      await handleAuthorizePost(req, res);
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      await handleToken(req, res);
      return;
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      await handleMcp(req, res);
      return;
    }
    if (await memoryAdmin(req, res, url)) return;
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: 'payload_too_large', message: `Request body exceeds ${MAX_BODY_BYTES} bytes.` });
      return;
    }
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`lily-github-mcp-bridge listening on :${PORT}`);
  console.log(`Allowed repos: ${[...ALLOWED_REPOS].join(', ')}`);
  console.log(`MCP endpoint (once deployed): ${BASE_URL}/mcp`);
});

// ---------------------------------------------------------------------------
// Self-ping — keeps a Render free-tier web service from spinning down after
// its inactivity timeout. Hits our own public /health endpoint on a timer.
// Set SELF_PING=false to disable (e.g. if you're on a paid "Always On" plan).
// ---------------------------------------------------------------------------

const SELF_PING_INTERVAL_MS = Number(process.env.SELF_PING_INTERVAL_MS || 10 * 60 * 1000); // 10 min

function selfPing() {
  https
    .get(`${BASE_URL}/health`, (res) => {
      res.resume(); // drain response body, don't hold the socket open
      console.log(`[self-ping] ${res.statusCode} at ${new Date().toISOString()}`);
    })
    .on('error', (err) => {
      console.error(`[self-ping] failed: ${err.message}`);
    });
}

if (process.env.SELF_PING !== 'false') {
  setInterval(selfPing, SELF_PING_INTERVAL_MS).unref();
  console.log(`Self-ping enabled: pinging ${BASE_URL}/health every ${SELF_PING_INTERVAL_MS / 1000}s`);
}

// ---------------------------------------------------------------------------
// Memory (Turso) — tools are added once the database is ready. If Turso is not
// configured or unreachable, the GitHub tools keep working without memory.
// ---------------------------------------------------------------------------

let memoryStore: MemoryStore | null = null;

async function initMemory() {
  if (!process.env.TURSO_DATABASE_URL) {
    console.warn('[memory] TURSO_DATABASE_URL not set — memory tools disabled.');
    return;
  }
  try {
    const store = new MemoryStore(await openTurso(), { trashDays: Number(process.env.TRASH_RETENTION_DAYS || 30) });
    await store.init();
    memoryStore = store;
    TOOLS.push(...buildMemoryTools(store));
    console.log(`[memory] ready (search: ${store.ftsEnabled ? 'FTS5' : 'LIKE fallback'}, trash kept ${store.trashDays} days).`);
    scheduleTrashPurge(store);
    scheduleBackup(store);
  } catch (err: any) {
    console.error(`[memory] init failed, memory tools disabled: ${err.message}`);
  }
}

// Removed entries stay restorable for TRASH_RETENTION_DAYS (default 30), then
// are erased for good. Checked at startup and daily.
function scheduleTrashPurge(store: MemoryStore) {
  const purge = () =>
    store.purgeExpiredTrash().then(
      (n) => n && console.log(`[memory] erased ${n} entries whose trash retention ended`),
      (err: any) => console.error(`[memory] trash purge failed: ${err.message}`)
    );
  setTimeout(purge, 30 * 1000).unref();
  setInterval(purge, 24 * 3600 * 1000).unref();
}

// Optional: back up all memories as JSONL into a (private!) GitHub repo.
function scheduleBackup(store: MemoryStore) {
  const repoFull = process.env.BACKUP_REPO;
  if (!repoFull) return;
  const [owner, repo] = repoFull.split('/');
  const filePath = process.env.BACKUP_PATH || 'memory-backup/memories.jsonl';
  const branch = process.env.BACKUP_BRANCH;
  const everyMs = Number(process.env.BACKUP_INTERVAL_HOURS || 24) * 3600 * 1000;

  async function backup() {
    try {
      assertRepoAllowed(owner, repo);
      const content = await store.exportJsonl();
      const q = branch ? `?ref=${encodeURIComponent(branch)}` : '';
      const cur = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${encodePath(filePath)}${q}`);
      let sha: string | undefined;
      if (cur.status === 200) {
        sha = cur.body.sha;
        const old = Buffer.from(cur.body.content || '', 'base64').toString('utf8');
        if (old === content) return console.log('[backup] unchanged, skipped');
      } else if (cur.status !== 404) {
        throw new Error(`GitHub ${cur.status}: ${JSON.stringify(cur.body)}`);
      }
      const put = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, {
        message: `memory backup ${new Date().toISOString()}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
        ...(branch ? { branch } : {}),
      });
      if (put.status >= 400) throw new Error(`GitHub ${put.status}: ${JSON.stringify(put.body)}`);
      console.log('[backup] memories backed up to GitHub');
    } catch (err: any) {
      console.error(`[backup] failed: ${err.message}`);
    }
  }
  setTimeout(backup, 60 * 1000).unref();
  setInterval(backup, everyMs).unref();
}

initMemory();
