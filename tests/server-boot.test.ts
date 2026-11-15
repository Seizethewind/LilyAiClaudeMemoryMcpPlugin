import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

/**
 * Boots the real server (src/server.ts) as a child process and drives it over HTTP, the way Render
 * and claude.ai do: health, OAuth with PKCE, then /mcp. No network is needed: GitHub is never called,
 * and Turso / PandaStack / Tavily are left unset (placeholders count as unset), so this also checks
 * that the server comes up and degrades cleanly without them.
 */

const ADMIN = 'admin-secret-for-the-boot-test-only';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let child: ChildProcess;
let base = '';
let log = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // A clean environment: nothing real can leak in, and nothing optional is configured.
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    NODE_PATH: process.env.NODE_PATH || '',
    GITHUB_TOKEN: 'dummy-token-never-used',
    MCP_ADMIN_SECRET: ADMIN,
    MCP_JWT_SECRET: 'jwt-secret-for-the-boot-test-only-123',
    MCP_BASE_URL: base,
    ALLOWED_REPOS: 'Seizethewind/*',
    PORT: String(port),
    SELF_PING: 'false',
    TAVILY_API_KEY: 'not_set',
    PANDASTACK_API_KEY: 'not_set',
  };
  child = spawn(process.execPath, [...process.execArgv, join(__dirname, '..', 'src', 'server.ts')], { env, cwd: join(__dirname, '..') });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const deadline = Date.now() + 20_000;
  while (!/listening on/.test(log)) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log}`);
    if (Date.now() > deadline) throw new Error(`server did not start in time:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  child?.kill();
});

const b64url = (b: Buffer) => b.toString('base64url');

async function rpc(token: string | null, method: string, params?: any) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

/** Full OAuth authorization-code + PKCE flow, returning both tokens. */
async function signIn() {
  const reg = await fetch(`${base}/register`, { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
  assert.equal(reg.status, 201);
  const clientId = ((await reg.json()) as any).client_id;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const form = (extra: Record<string, string>) =>
    new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, state: 's1', code_challenge: challenge, code_challenge_method: 'S256', ...extra });
  const bad = await fetch(`${base}/authorize`, { method: 'POST', body: form({ secret: 'wrong' }), redirect: 'manual' });
  assert.equal(bad.status, 401, 'a wrong admin secret must be refused');
  const ok = await fetch(`${base}/authorize`, { method: 'POST', body: form({ secret: ADMIN }), redirect: 'manual' });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location')!);
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 's1');
  const code = loc.searchParams.get('code')!;
  const wrongVerifier = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'x'.repeat(43) }) });
  assert.equal(wrongVerifier.status, 400, 'PKCE must be enforced');
  const tok = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }) });
  assert.equal(tok.status, 200);
  const t = (await tok.json()) as any;
  assert.ok(t.access_token && t.refresh_token);
  return t as { access_token: string; refresh_token: string };
}

test('server boots, reports healthy, and says what is switched off', async () => {
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { status: 'ok' });
  assert.match(log, /TURSO_DATABASE_URL not set/);
  assert.match(log, /\[tavily\] TAVILY_API_KEY not set/);
  assert.match(log, /PANDASTACK_API_KEY not set/);
  assert.doesNotMatch(log, /enabled \(\d+\)/, 'placeholder keys must not enable sandbox tools');
  assert.doesNotMatch(log, /web search enabled/);
});

test('/mcp refuses callers without a valid access token and points them at OAuth', async () => {
  const none = await rpc(null, 'tools/list');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate') || '', /resource_metadata=/);
  const junk = await rpc('not.a.token', 'tools/list');
  assert.equal(junk.status, 401);
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual((meta as any).code_challenge_methods_supported, ['S256']);
});

test('OAuth with PKCE works end to end, and a refresh token cannot be used on /mcp', async () => {
  const t = await signIn();
  const init = await rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'lily-github-mcp-bridge');
  assert.match(init.json.result.instructions, /pull requests, issues and Actions/);
  const asRefresh = await rpc(t.refresh_token, 'tools/list');
  assert.equal(asRefresh.status, 401, 'only access tokens may call /mcp');
  const renewed = await fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }) });
  assert.equal(renewed.status, 200);
});

test('tools/list: GitHub, PR/issue/CI and guide tools are there; optional groups are not', async () => {
  const t = await signIn();
  const r = await rpc(t.access_token, 'tools/list');
  const tools = r.json.result.tools as any[];
  const names = tools.map((x) => x.name);
  for (const n of ['get_file_contents', 'create_or_update_file', 'push_files', 'create_branch', 'get_breakdown_guide', 'get_skill', 'pr_create', 'pr_get', 'issue_create', 'actions_runs', 'actions_job_logs']) assert.ok(names.includes(n), n);
  for (const n of ['pr_merge', 'pr_approve', 'actions_dispatch']) assert.ok(!names.includes(n), `${n} must not exist`);
  assert.ok(!names.some((n) => n.startsWith('sandbox_') || n.startsWith('memory_') || n.startsWith('blueprint_')), 'no sandbox or memory tools without their config');
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const x of tools) assert.ok(x.annotations, `${x.name} has behaviour hints`);
  assert.equal(tools.find((x) => x.name === 'pr_get').annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === 'delete_file').annotations.destructiveHint, true);
});

test('get_skill serves a skill over the real connection', async () => {
  const t = await signIn();
  const r = (await rpc(t.access_token, 'tools/call', { name: 'get_skill', arguments: { name: 'ship-a-change' } })).json.result;
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /pr_create/);
  const init = await rpc(t.access_token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.match(init.json.result.instructions, /Process skills \(/);
});

test('repo allowlists are enforced before any GitHub call is made', async () => {
  const t = await signIn();
  const call = async (name: string, args: any) => (await rpc(t.access_token, 'tools/call', { name, arguments: args })).json.result;
  const read = await call('pr_list', { owner: 'someone-else', repo: 'repo' });
  assert.equal(read.isError, true);
  assert.match(read.content[0].text, /not in ALLOWED_REPOS/);
  const write = await call('create_or_update_file', { owner: 'someone-else', repo: 'repo', path: 'a', content: 'x', message: 'm', branch: 'b' });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /not in ALLOWED_REPOS/);
  const bad = await call('pr_list', { owner: '../x', repo: 'repo' });
  assert.equal(bad.isError, true);
});

test('the admin page does not hand anything to an anonymous visitor', async () => {
  const r = await fetch(`${base}/admin/memory`, { redirect: 'manual' });
  const body = await r.text();
  assert.ok([200, 302, 303].includes(r.status), `status ${r.status}`);
  assert.doesNotMatch(body, /Empty trash|Delete blueprint|WIPE ALL MEMORY/);
  const post = await fetch(`${base}/admin/memory/action`, { method: 'POST', body: new URLSearchParams({ action: 'wipe_all', phrase: 'WIPE ALL MEMORY' }), redirect: 'manual' });
  assert.notEqual(post.status, 200, 'an anonymous action must not succeed');
  const unknown = await fetch(`${base}/does-not-exist`);
  assert.equal(unknown.status, 404);
});
