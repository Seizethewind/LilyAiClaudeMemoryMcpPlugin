/**
 * PandaStack MCP tools. Every tool goes through PandaStackClient, which handles key rotation.
 *
 * Endpoint confidence: sandboxes, exec, files, templates list and preview URLs follow the
 * documented REST reference. The remaining paths (snapshots, forks, lifecycle, volumes, ports,
 * databases, apps, template builds) follow PandaStack's REST naming but were not all verifiable
 * against a live account, so those tools accept pass-through bodies, and `pandastack_api` can
 * reach any /v1 endpoint directly if a path differs.
 */
import { randomBytes } from 'node:crypto';
import { PandaStackClient, assertAbsPath, assertId, assertName, clamp, cut, enc, toolError } from './client';

const RO = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const IDEM = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTROY_ONCE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const SANDBOX_ANNOTATIONS: Record<string, Record<string, boolean>> = {};
for (const n of [
  'sandbox_templates', 'sandbox_template_get', 'sandbox_template_builds', 'sandbox_list', 'sandbox_get', 'sandbox_preview_url', 'sandbox_read_file',
  'sandbox_list_dir', 'sandbox_stat', 'sandbox_logs', 'sandbox_lifecycle_get', 'sandbox_ports', 'sandbox_snapshot_list', 'sandbox_snapshot_get',
  'sandbox_fork_tree', 'volume_list', 'volume_get', 'database_list', 'database_get', 'database_connection', 'app_list', 'app_get', 'app_deploys',
  'app_logs', 'pandastack_status',
]) SANDBOX_ANNOTATIONS[n] = RO;
for (const n of [
  'sandbox_create', 'sandbox_browser_screenshot', 'sandbox_snapshot_create', 'sandbox_fork', 'sandbox_template_build', 'volume_create',
  'database_create', 'app_create', 'app_deploy', 'web_search', 'web_fetch',
]) SANDBOX_ANNOTATIONS[n] = WRITE;
for (const n of ['sandbox_pause', 'sandbox_resume', 'sandbox_hibernate', 'sandbox_wake', 'sandbox_lifecycle_set', 'sandbox_expose_port', 'sandbox_promote', 'app_update', 'app_rollback'])
  SANDBOX_ANNOTATIONS[n] = IDEM;
for (const n of ['sandbox_delete', 'sandbox_write_file', 'sandbox_remove_path', 'sandbox_remove_port', 'sandbox_snapshot_delete', 'sandbox_template_delete', 'volume_delete', 'database_delete', 'app_delete'])
  SANDBOX_ANNOTATIONS[n] = DESTROY;
for (const n of ['sandbox_exec', 'database_query', 'pandastack_api']) SANDBOX_ANNOTATIONS[n] = DESTROY_ONCE;

export const SANDBOX_HINT =
  'PandaStack (sandbox_*, volume_*, database_*, app_*, web_* tools): disposable Firecracker microVMs. Use template "browser" for Chromium + Playwright. Create one, work in /workspace, then sandbox_delete it. Sandboxes expire on their own (ttl). web_search / web_fetch drive Chromium in a helper sandbox, so no sandbox id is needed. Several API keys may be configured; they rotate automatically and each resource stays with the key that made it. Preview URLs are public to anyone who has the link.';

const ID_PROP = { type: 'string', description: 'Sandbox id returned by sandbox_create.' };
const SLOT_PROP = { type: 'integer', description: 'Optional: use this API key slot (1-based) instead of the automatic rotation. Normally leave unset.' };
const BODY_PROP = { type: 'object', description: 'Extra fields passed straight to the PandaStack API.' };

function obj(v: any, what: string): Record<string, any> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) toolError(`${what} must be an object.`);
  if (JSON.stringify(v).length > 100_000) toolError(`${what} is too large.`);
  return v;
}

const done = (r: any, extra: Record<string, any> = {}) => (r === null || r === undefined || r === '' ? { ok: true, ...extra } : r);

// Python run inside a "browser" sandbox. The job (URLs, queries) is a JSON file, never spliced into code or a shell line.
const RUN_SCRIPT = `
import json, sys, base64
from urllib.parse import urlparse, parse_qs, unquote, quote
from playwright.sync_api import sync_playwright

job = json.load(open(sys.argv[1]))
op = job.get('op', 'screenshot')
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
ENGINES = {
    'duckduckgo': ('https://html.duckduckgo.com/html/?q=', '.result', 'a.result__a', '.result__snippet'),
    'bing': ('https://www.bing.com/search?q=', 'li.b_algo', 'h2 a', '.b_caption p, p'),
}

def unwrap(href):
    try:
        u = urlparse(href)
        if u.netloc.endswith('duckduckgo.com') and u.path.startswith('/l/'):
            v = parse_qs(u.query).get('uddg')
            if v:
                return unquote(v[0])
        if u.netloc.endswith('bing.com') and u.path.startswith('/ck/'):
            v = parse_qs(u.query).get('u')
            if v and v[0].startswith('a1'):
                s = v[0][2:]
                s += '=' * (-len(s) % 4)
                return base64.urlsafe_b64decode(s).decode('utf-8', 'replace')
    except Exception:
        pass
    if href.startswith('//'):
        return 'https:' + href
    return href

def search(page, engine, q, n):
    base, box, link, snip = ENGINES[engine]
    page.goto(base + quote(q), wait_until='domcontentloaded', timeout=job['timeout_ms'])
    out = []
    for el in page.query_selector_all(box):
        a = el.query_selector(link)
        if not a:
            continue
        url = unwrap(a.get_attribute('href') or '')
        if not url.startswith('http') or 'duckduckgo.com/y.js' in url:
            continue
        s = el.query_selector(snip)
        out.append({'title': a.inner_text().strip(), 'url': url, 'snippet': s.inner_text().strip() if s else ''})
        if len(out) >= n:
            break
    return out

def page_text(ctx, url, limit):
    pg = ctx.new_page()
    try:
        pg.goto(url, wait_until='domcontentloaded', timeout=20000)
        return pg.inner_text('body')[:limit], None
    except Exception as e:
        return None, str(e)[:200]
    finally:
        pg.close()

out = {'ok': False}
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
    try:
        ctx = browser.new_context(viewport={'width': job.get('width', 1280), 'height': job.get('height', 720)}, user_agent=UA, locale='en-US')
        page = ctx.new_page()
        if op == 'search':
            engines = [job['engine']] + [e for e in ENGINES if e != job['engine']]
            results, used, errors = [], None, []
            for eng in engines:
                try:
                    results = search(page, eng, job['query'], job['max_results'])
                except Exception as e:
                    errors.append(eng + ': ' + str(e)[:150])
                    continue
                if results:
                    used = eng
                    break
            if job.get('fetch_pages'):
                for r in results[: job['fetch_pages']]:
                    t, err = page_text(ctx, r['url'], job['page_chars'])
                    if t is not None:
                        r['page_text'] = t
                    else:
                        r['page_error'] = err
            out = {'ok': True, 'engine': used, 'results': results, 'errors': errors}
        elif op == 'fetch':
            resp = page.goto(job['url'], wait_until=job['wait_until'], timeout=job['timeout_ms'])
            if job.get('wait_ms'):
                page.wait_for_timeout(job['wait_ms'])
            out = {'ok': True, 'status': resp.status if resp else None, 'title': page.title(), 'final_url': page.url, 'text': page.inner_text('body')}
            if job.get('links'):
                out['links'] = page.evaluate("() => Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map(a => ({text: (a.innerText || '').trim().slice(0, 120), href: a.href}))")
        else:
            resp = page.goto(job['url'], wait_until=job['wait_until'], timeout=job['timeout_ms'])
            if job.get('wait_ms'):
                page.wait_for_timeout(job['wait_ms'])
            page.screenshot(path=job['out'], full_page=job['full_page'])
            out = {'ok': True, 'status': resp.status if resp else None, 'title': page.title(), 'final_url': page.url}
            if job.get('extract_text'):
                out['text'] = page.inner_text('body')
    finally:
        browser.close()
print(json.dumps(out))
`;

const WAIT = ['load', 'domcontentloaded', 'networkidle'];

function httpUrl(u: any): string {
  let t: URL;
  try {
    t = new URL(String(u));
  } catch {
    return toolError('url is not a valid URL.');
  }
  if (t.protocol !== 'http:' && t.protocol !== 'https:') toolError('Only http and https URLs can be opened.');
  return t.toString();
}

/** Where an API path's resource lives, so a raw call follows the key that owns it. */
function affinityFromPath(path: string): string | undefined {
  const m = /^\/v1\/(sandboxes|volumes|snapshots|databases|apps|templates)\/([^/?#]+)/.exec(path);
  if (!m) return undefined;
  const prefix = { sandboxes: '', volumes: 'vol:', snapshots: 'snap:', databases: 'db:', apps: 'app:', templates: 'tpl:' }[m[1]];
  return `${prefix}${decodeURIComponent(m[2])}`;
}

export function buildAllTools(c: PandaStackClient): any[] {
  const sb = (id: any, rest = '') => `/v1/sandboxes/${enc(assertId(id))}${rest}`;
  const T: any[] = [];
  const add = (name: string, description: string, properties: Record<string, any>, required: string[], handler: (a: any) => Promise<any>) =>
    T.push({ name, description, inputSchema: { type: 'object', properties, required }, handler: async (a: any) => handler(a || {}) });

  // ---- helper sandbox + job runner (screenshot, web_search, web_fetch) ----
  async function execJob(id: string, job: any, timeoutSeconds: number) {
    const base = sb(id);
    const jobPath = `/workspace/.lily/job-${randomBytes(6).toString('hex')}.json`;
    await c.request('PUT', `${base}/fs`, { affinity: id, query: { path: jobPath }, body: Buffer.from(JSON.stringify(job)) });
    await c.request('PUT', `${base}/fs`, { affinity: id, query: { path: '/workspace/.lily/run.py' }, body: Buffer.from(RUN_SCRIPT.trimStart()) });
    const r = await c.request('POST', `${base}/exec`, {
      affinity: id,
      json: { cmd: `python3 /workspace/.lily/run.py ${jobPath}; code=$?; rm -f ${jobPath}; exit $code`, timeout_seconds: timeoutSeconds },
      timeoutMs: (timeoutSeconds + 15) * 1000,
    });
    const code = r ? (r.exit_code ?? r.exitCode) : null;
    if (code !== 0) {
      const e = cut(String((r && r.stderr) || (r && r.stdout) || ''), 4000);
      toolError(`Browser job failed (exit ${code}). Is this a "browser" template sandbox? ${e.text.split('\n').slice(-12).join('\n')}`);
    }
    try {
      return JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}');
    } catch {
      return toolError('Browser job returned unexpected output.');
    }
  }

  const helpers = new Map<number, string>();
  const pending = new Map<number, Promise<string>>();
  async function helperAlive(i: number) {
    const id = helpers.get(i);
    if (!id) return undefined;
    try {
      const s = await c.request('GET', sb(id), { keySlot: i + 1 });
      if (c.isAlive(s)) return id;
    } catch {
      /* gone or unreachable: make a new one */
    }
    helpers.delete(i);
    return undefined;
  }
  /** One reusable browser sandbox per API key, picked in rotation so searches spread across keys. */
  async function helperSandbox(): Promise<string> {
    const order = c.ring.order();
    let last: any;
    for (const i of order) {
      const existing = await helperAlive(i);
      if (existing) return existing;
      let p = pending.get(i);
      if (!p) {
        p = c
          .create({ template: 'browser', ttl_seconds: c.maxTtl, metadata: { role: 'web-helper' }, key_slot: i + 1 })
          .then((s: any) => {
            helpers.set(i, String(s.id));
            return String(s.id);
          })
          .finally(() => pending.delete(i));
        pending.set(i, p);
      }
      try {
        return await p;
      } catch (e: any) {
        last = e;
      }
    }
    for (const i of helpers.keys()) {
      const id = await helperAlive(i);
      if (id) return id;
    }
    throw last;
  }

  // ---- status ----
  add('pandastack_status', 'Show PandaStack connection state: how many API keys are configured, which are ready or resting (never the keys themselves), plus health and version if the API reports them.', {}, [], async () => {
    const probe = async (path: string) => {
      try {
        return await c.request('GET', path, { noAuth: true, timeoutMs: 10_000 });
      } catch (e: any) {
        return { error: e.message };
      }
    };
    return {
      api_url: c.apiUrl,
      preview_host: c.previewHost,
      keys: c.ring.size,
      rotation: c.ring.status(),
      limits: { max_active: c.maxActive, default_ttl_seconds: c.defaultTtl, max_ttl_seconds: c.maxTtl },
      health: await probe('/healthz'),
      version: await probe('/version'),
    };
  });

  // ---- sandboxes ----
  add('sandbox_templates', 'List the PandaStack templates you can boot a sandbox from (e.g. "browser" = Chromium + Playwright, "code-interpreter" = Python + data libs, "base" = Ubuntu with Node/Python/Go/Bun).', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/templates', { affinityPrefix: 'tpl:', idField: 'name' });
    return { templates: rows, ...(errors.length ? { errors } : {}) };
  });
  add('sandbox_create',
    `Boot a disposable PandaStack microVM (about 0.2 s from a snapshot). template defaults to "browser" (headless Chromium + Playwright + Python/Node). ttl_seconds sets its lifetime (default ${c.defaultTtl}, max ${c.maxTtl}). At most ${c.maxActive} sandboxes made by this bridge can be live at once. Work in /workspace. from_snapshot boots from a saved snapshot; volumes attaches persistent volumes (see volume_create). With several API keys the next key in rotation is used.`,
    {
      template: { type: 'string', description: 'Template name. Default "browser" (or the snapshot\'s own template).' },
      ttl_seconds: { type: 'integer', description: `Lifetime in seconds, 60 to ${c.maxTtl}.` },
      metadata: { type: 'object', description: 'Optional string tags, e.g. {"job":"login-test"}.' },
      from_snapshot: { type: 'string', description: 'Snapshot id to boot from.' },
      volumes: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, read_only: { type: 'boolean' } }, required: ['name'] }, description: 'Volumes to attach.' },
      key_slot: SLOT_PROP,
    }, [], (a) => c.create(a));
  add('sandbox_list', 'List sandboxes across all configured API keys (all of them, not only the ones this bridge made; ours have metadata.source = "lily-mcp"). key_slot tells which key owns each row.', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/sandboxes');
    return { sandboxes: rows, ...(errors.length ? { errors } : {}) };
  });
  add('sandbox_get', 'Describe one sandbox: status, template, boot time.', { id: ID_PROP }, ['id'], ({ id }) => c.request('GET', sb(id), { affinity: id }));
  add('sandbox_delete', 'Permanently delete a sandbox and everything in it. Do this when the work is done.', { id: ID_PROP }, ['id'], async ({ id }) => {
    await c.request('DELETE', sb(id), { affinity: id });
    return { deleted: id };
  });
  add('sandbox_exec',
    'Run a shell command in the sandbox (sh -c: pipes, &&, heredocs all work) and wait for it. Returns stdout, stderr, exit_code, duration_ms; each stream is cut at 20,000 characters. There is no separate cwd/env field, so use "cd /workspace/x && ..." and "KEY=value cmd". Start long-running servers in the background (nohup ... &).',
    { id: ID_PROP, cmd: { type: 'string', description: 'Shell command line.' }, timeout_seconds: { type: 'integer', description: 'Kill after this many seconds. Default 60, max 300.' } },
    ['id', 'cmd'], async ({ id, cmd, timeout_seconds }) => {
      assertId(id);
      if (typeof cmd !== 'string' || !cmd.trim()) toolError('cmd is required.');
      const t = clamp(Math.floor(Number(timeout_seconds) || 60), 1, 300);
      const r = await c.request('POST', sb(id, '/exec'), { affinity: id, json: { cmd, timeout_seconds: t }, timeoutMs: (t + 15) * 1000 });
      const out = cut(r && r.stdout);
      const err = cut(r && r.stderr);
      return {
        exit_code: r ? (r.exit_code ?? r.exitCode) : null,
        duration_ms: r && r.duration_ms,
        stdout: out.text,
        stderr: err.text,
        ...(out.truncated ? { stdout_truncated_from: out.total_chars } : {}),
        ...(err.truncated ? { stderr_truncated_from: err.total_chars } : {}),
      };
    });
  add('sandbox_write_file', 'Write a file inside the sandbox (parent folders are created, an existing file is overwritten). Use encoding "base64" for binary content. Keep files small (a few MB).',
    { id: ID_PROP, path: { type: 'string', description: 'Absolute path, e.g. /workspace/app.py' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8.' } },
    ['id', 'path', 'content'], async ({ id, path, content, encoding }) => {
      assertId(id);
      assertAbsPath(path);
      if (typeof content !== 'string') toolError('content must be a string.');
      const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      return done(await c.request('PUT', sb(id, '/fs'), { affinity: id, query: { path }, body: bytes, timeoutMs: 60_000 }), { path, bytes: bytes.length });
    });
  add('sandbox_read_file', 'Read a file from the sandbox. Returns text (utf8) or base64, cut at max_bytes (default 200000, max 2000000). The whole file is loaded server-side, so cut big files with exec (head, tar) first.',
    { id: ID_PROP, path: { type: 'string', description: 'Absolute path.' }, encoding: { type: 'string', enum: ['utf8', 'base64'] }, max_bytes: { type: 'integer' } },
    ['id', 'path'], async ({ id, path, encoding, max_bytes }) => {
      assertId(id);
      assertAbsPath(path);
      const cap = clamp(Math.floor(Number(max_bytes) || 200_000), 1, 2_000_000);
      const buf: Buffer = await c.request('GET', sb(id, '/fs'), { affinity: id, query: { path }, raw: true, timeoutMs: 60_000 });
      const part = buf.subarray(0, cap);
      return { path, bytes: buf.length, truncated: buf.length > cap, encoding: encoding === 'base64' ? 'base64' : 'utf8', content: part.toString(encoding === 'base64' ? 'base64' : 'utf8') };
    });
  add('sandbox_list_dir', 'List a directory inside the sandbox.', { id: ID_PROP, path: { type: 'string', description: 'Absolute directory path. Default /workspace.' } }, ['id'],
    ({ id, path }) => c.request('GET', sb(id, '/fs/dir'), { affinity: id, query: { path: assertAbsPath(path || '/workspace') } }));
  add('sandbox_stat', 'Size, type and modification time of one path inside the sandbox.', { id: ID_PROP, path: { type: 'string' } }, ['id', 'path'],
    ({ id, path }) => c.request('GET', sb(id, '/fs/stat'), { affinity: id, query: { path: assertAbsPath(path) } }));
  add('sandbox_remove_path', 'Delete a file or empty directory inside the sandbox (use sandbox_exec "rm -rf" for trees).', { id: ID_PROP, path: { type: 'string' } }, ['id', 'path'],
    async ({ id, path }) => done(await c.request('DELETE', sb(id, '/fs'), { affinity: id, query: { path: assertAbsPath(path) } }), { removed: path }));
  add('sandbox_logs', 'Console / boot logs of a sandbox.', { id: ID_PROP }, ['id'], async ({ id }) => {
    const r = await c.request('GET', sb(id, '/logs'), { affinity: id });
    const t = cut(r);
    return { logs: t.text, ...(t.truncated ? { truncated_from: t.total_chars } : {}) };
  });
  add('sandbox_preview_url', 'Public HTTPS URL for a port inside the sandbox (something must be listening on it). Anyone holding the link can reach that port until the sandbox is deleted, so treat it as a secret and do not expose anything private.',
    { id: ID_PROP, port: { type: 'integer', description: '1-65535' } }, ['id', 'port'], async ({ id, port }) => {
      assertId(id);
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) toolError('port must be an integer from 1 to 65535.');
      return { url: c.previewUrl(id, n), warning: 'Public to anyone with this link until the sandbox is deleted.' };
    });
  const portNo = (p: any) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) toolError('port must be an integer from 1 to 65535.');
    return n;
  };
  add('sandbox_ports', 'List the ports currently exposed for a sandbox.', { id: ID_PROP }, ['id'], ({ id }) => c.request('GET', sb(id, '/ports'), { affinity: id }));
  add('sandbox_expose_port', 'Expose a port of the sandbox through its preview URL. The URL is public to anyone with the link.', { id: ID_PROP, port: { type: 'integer' }, body: BODY_PROP }, ['id', 'port'],
    async ({ id, port, body }) => ({ ...(done(await c.request('POST', sb(id, '/ports'), { affinity: id, json: { ...obj(body, 'body'), port: portNo(port) } })) as any), url: c.previewUrl(id, portNo(port)) }));
  add('sandbox_remove_port', 'Stop exposing a port.', { id: ID_PROP, port: { type: 'integer' } }, ['id', 'port'],
    async ({ id, port }) => done(await c.request('DELETE', sb(id, `/ports/${portNo(port)}`), { affinity: id }), { removed_port: portNo(port) }));

  // ---- lifecycle ----
  for (const [name, verb, text] of [
    ['sandbox_pause', 'pause', 'Pause a running sandbox (memory kept, CPU stopped).'],
    ['sandbox_resume', 'resume', 'Resume a paused sandbox.'],
    ['sandbox_hibernate', 'hibernate', 'Hibernate a sandbox to disk to stop using compute; wake it later.'],
    ['sandbox_wake', 'wake', 'Wake a hibernated sandbox.'],
  ]) add(name, text, { id: ID_PROP }, ['id'], async ({ id }) => done(await c.request('POST', sb(id, `/${verb}`), { affinity: id }), { id, action: verb }));
  add('sandbox_lifecycle_get', 'Read a sandbox\'s lifecycle policy (idle timeout, auto-hibernate, ttl).', { id: ID_PROP }, ['id'], ({ id }) => c.request('GET', sb(id, '/lifecycle'), { affinity: id }));
  add('sandbox_lifecycle_set', 'Change a sandbox\'s lifecycle policy. policy holds the fields to change, exactly as PandaStack names them (see sandbox_lifecycle_get). ttl is still capped by SANDBOX_MAX_TTL_SECONDS.',
    { id: ID_PROP, policy: { type: 'object' } }, ['id', 'policy'], async ({ id, policy }) => {
      const p = obj(policy, 'policy');
      for (const k of ['ttl_seconds', 'ttl']) if (p[k] !== undefined) p[k] = clamp(Math.floor(Number(p[k]) || c.defaultTtl), 60, c.maxTtl);
      return done(await c.request('PATCH', sb(id, '/lifecycle'), { affinity: id, json: p }));
    });

  // ---- snapshots and forks ----
  add('sandbox_snapshot_create', 'Save the full state of a sandbox as a snapshot. Boot new sandboxes from it with sandbox_create from_snapshot, or fork.', { id: ID_PROP, name: { type: 'string' }, body: BODY_PROP }, ['id'],
    async ({ id, name, body }) => {
      const r: any = await c.request('POST', sb(id, '/snapshots'), { affinity: id, json: { ...obj(body, 'body'), ...(name ? { name: assertName(name, 'snapshot name') } : {}) } });
      const o = c.ownerOf(id);
      if (r && r.id && o !== undefined) c.setOwner('snap:' + r.id, o);
      return done(r);
    });
  add('sandbox_snapshot_list', 'List snapshots across all configured API keys.', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/snapshots', { affinityPrefix: 'snap:' });
    return { snapshots: rows, ...(errors.length ? { errors } : {}) };
  });
  add('sandbox_snapshot_get', 'Describe one snapshot.', { snapshot_id: { type: 'string' } }, ['snapshot_id'],
    ({ snapshot_id }) => c.request('GET', `/v1/snapshots/${enc(assertId(snapshot_id, 'snapshot id'))}`, { affinity: 'snap:' + snapshot_id }));
  add('sandbox_snapshot_delete', 'Delete a snapshot.', { snapshot_id: { type: 'string' } }, ['snapshot_id'],
    async ({ snapshot_id }) => done(await c.request('DELETE', `/v1/snapshots/${enc(assertId(snapshot_id, 'snapshot id'))}`, { affinity: 'snap:' + snapshot_id }), { deleted: snapshot_id }));
  add('sandbox_fork', 'Fork a running sandbox into count copies that continue from the same state (counts against the live-sandbox limit).', { id: ID_PROP, count: { type: 'integer', description: '1-5, default 1.' }, ttl_seconds: { type: 'integer' } }, ['id'],
    async ({ id, count, ttl_seconds }) => {
      assertId(id);
      const n = clamp(Math.floor(Number(count) || 1), 1, 5);
      await c.assertRoom(n);
      const r: any = await c.request('POST', sb(id, '/fork'), {
        affinity: id,
        json: { count: n, ttl_seconds: clamp(Math.floor(Number(ttl_seconds) || c.defaultTtl), 60, c.maxTtl), metadata: { source: 'lily-mcp', forked_from: id } },
        timeoutMs: 60_000,
      });
      const o = c.ownerOf(id);
      const list = Array.isArray(r) ? r : r && Array.isArray(r.sandboxes) ? r.sandboxes : r && r.id ? [r] : [];
      if (o !== undefined) for (const s of list) if (s && s.id) c.setOwner(String(s.id), o);
      return r;
    });
  add('sandbox_fork_tree', 'Show the fork tree (parent and children) of a sandbox.', { id: ID_PROP }, ['id'], ({ id }) => c.request('GET', sb(id, '/forks'), { affinity: id }));
  add('sandbox_promote', 'Promote a forked sandbox so it no longer depends on its parent.', { id: ID_PROP }, ['id'], async ({ id }) => done(await c.request('POST', sb(id, '/promote'), { affinity: id }), { promoted: id }));

  // ---- templates ----
  const tpl = (n: any) => `/v1/templates/${enc(assertName(n, 'template name'))}`;
  add('sandbox_template_get', 'Describe one template.', { name: { type: 'string' } }, ['name'], ({ name }) => c.request('GET', tpl(name), { affinity: 'tpl:' + name }));
  add('sandbox_template_build', 'Build a custom template (for example from a Dockerfile or base image). config is passed to PandaStack as is; see template docs for the fields.', { name: { type: 'string' }, config: BODY_PROP, key_slot: SLOT_PROP }, ['name', 'config'],
    async ({ name, config, key_slot }) => {
      let used = -1;
      const r = await c.request('POST', '/v1/templates', { json: { ...obj(config, 'config'), name: assertName(name, 'template name') }, keySlot: key_slot, timeoutMs: 60_000, onKey: (i) => (used = i) });
      if (used >= 0) c.setOwner('tpl:' + name, used);
      return done(r, { name });
    });
  add('sandbox_template_builds', 'Build history and status of a template.', { name: { type: 'string' } }, ['name'], ({ name }) => c.request('GET', tpl(name) + '/builds', { affinity: 'tpl:' + name }));
  add('sandbox_template_delete', 'Delete a custom template.', { name: { type: 'string' } }, ['name'], async ({ name }) => done(await c.request('DELETE', tpl(name), { affinity: 'tpl:' + name }), { deleted: name }));

  // ---- volumes ----
  const vol = (n: any) => `/v1/volumes/${enc(assertName(n, 'volume name'))}`;
  add('volume_create', 'Create a persistent volume that survives sandbox deletion. Attach it with sandbox_create volumes:[{name}] (it is mounted by PandaStack; the volume lives under the key that created it).', { name: { type: 'string' }, size_gb: { type: 'integer' }, body: BODY_PROP, key_slot: SLOT_PROP }, ['name'],
    async ({ name, size_gb, body, key_slot }) => {
      let used = -1;
      const payload: any = { ...obj(body, 'body'), name: assertName(name, 'volume name') };
      if (size_gb !== undefined) payload.size_gb = clamp(Math.floor(Number(size_gb) || 1), 1, 1000);
      const r = await c.request('POST', '/v1/volumes', { json: payload, keySlot: key_slot, onKey: (i) => (used = i) });
      if (used >= 0) c.setOwner('vol:' + name, used);
      return done(r, { name });
    });
  add('volume_list', 'List volumes across all configured API keys.', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/volumes', { affinityPrefix: 'vol:', idField: 'name' });
    return { volumes: rows, ...(errors.length ? { errors } : {}) };
  });
  add('volume_get', 'Describe one volume.', { name: { type: 'string' } }, ['name'], ({ name }) => c.request('GET', vol(name), { affinity: 'vol:' + name }));
  add('volume_delete', 'Delete a volume and its data permanently.', { name: { type: 'string' } }, ['name'], async ({ name }) => done(await c.request('DELETE', vol(name), { affinity: 'vol:' + name }), { deleted: name }));

  // ---- databases ----
  const dbp = (i: any) => `/v1/databases/${enc(assertId(i, 'database id'))}`;
  add('database_create', 'Create a managed database. config holds PandaStack\'s fields (engine, name, size...).', { config: BODY_PROP, key_slot: SLOT_PROP }, ['config'], async ({ config, key_slot }) => {
    let used = -1;
    const r: any = await c.request('POST', '/v1/databases', { json: obj(config, 'config'), keySlot: key_slot, onKey: (i) => (used = i) });
    if (r && r.id && used >= 0) c.setOwner('db:' + r.id, used);
    return done(r);
  });
  add('database_list', 'List managed databases across all configured API keys.', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/databases', { affinityPrefix: 'db:' });
    return { databases: rows, ...(errors.length ? { errors } : {}) };
  });
  add('database_get', 'Describe one database.', { id: { type: 'string' } }, ['id'], ({ id }) => c.request('GET', dbp(id), { affinity: 'db:' + id }));
  add('database_connection', 'Connection details of a database. The result may contain credentials; do not repeat them in public places.', { id: { type: 'string' } }, ['id'], ({ id }) => c.request('GET', dbp(id) + '/connection', { affinity: 'db:' + id }));
  add('database_query', 'Run one SQL statement against a database through PandaStack\'s broker. It can change or delete data.', { id: { type: 'string' }, sql: { type: 'string' } }, ['id', 'sql'], async ({ id, sql }) => {
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 20_000) toolError('sql is required (max 20,000 characters).');
    const r = await c.request('POST', dbp(id) + '/query', { affinity: 'db:' + id, json: { sql }, timeoutMs: 60_000 });
    const t = cut(r, 50_000);
    return t.truncated ? { result: t.text, truncated_from: t.total_chars } : r;
  });
  add('database_delete', 'Delete a database permanently.', { id: { type: 'string' } }, ['id'], async ({ id }) => done(await c.request('DELETE', dbp(id), { affinity: 'db:' + id }), { deleted: id }));

  // ---- apps ----
  const app = (i: any) => `/v1/apps/${enc(assertId(i, 'app id'))}`;
  add('app_create', 'Create a deployable app. config holds PandaStack\'s fields (name, source/repo, runtime, env...).', { config: BODY_PROP, key_slot: SLOT_PROP }, ['config'], async ({ config, key_slot }) => {
    let used = -1;
    const r: any = await c.request('POST', '/v1/apps', { json: obj(config, 'config'), keySlot: key_slot, onKey: (i) => (used = i) });
    if (r && r.id && used >= 0) c.setOwner('app:' + r.id, used);
    return done(r);
  });
  add('app_list', 'List apps across all configured API keys.', {}, [], async () => {
    const { rows, errors } = await c.listAll('/v1/apps', { affinityPrefix: 'app:' });
    return { apps: rows, ...(errors.length ? { errors } : {}) };
  });
  add('app_get', 'Describe one app.', { id: { type: 'string' } }, ['id'], ({ id }) => c.request('GET', app(id), { affinity: 'app:' + id }));
  add('app_update', 'Change an app\'s settings. changes holds the fields to change.', { id: { type: 'string' }, changes: BODY_PROP }, ['id', 'changes'], async ({ id, changes }) => done(await c.request('PATCH', app(id), { affinity: 'app:' + id, json: obj(changes, 'changes') })));
  add('app_deploy', 'Start a new deployment of an app.', { id: { type: 'string' }, config: BODY_PROP }, ['id'], async ({ id, config }) => done(await c.request('POST', app(id) + '/deploys', { affinity: 'app:' + id, json: obj(config, 'config'), timeoutMs: 60_000 })));
  add('app_deploys', 'Deployment history of an app.', { id: { type: 'string' } }, ['id'], ({ id }) => c.request('GET', app(id) + '/deploys', { affinity: 'app:' + id }));
  add('app_logs', 'Build/deploy logs, or runtime logs when runtime is true.', { id: { type: 'string' }, runtime: { type: 'boolean' } }, ['id'], async ({ id, runtime }) => {
    const r = await c.request('GET', app(id) + (runtime ? '/runtime-logs' : '/logs'), { affinity: 'app:' + id });
    const t = cut(r);
    return { logs: t.text, ...(t.truncated ? { truncated_from: t.total_chars } : {}) };
  });
  add('app_rollback', 'Roll an app back to an earlier deployment.', { id: { type: 'string' }, deploy_id: { type: 'string' } }, ['id', 'deploy_id'],
    async ({ id, deploy_id }) => done(await c.request('POST', app(id) + '/rollback', { affinity: 'app:' + id, json: { deploy_id: assertId(deploy_id, 'deploy id') } })));
  add('app_delete', 'Delete an app permanently.', { id: { type: 'string' } }, ['id'], async ({ id }) => done(await c.request('DELETE', app(id), { affinity: 'app:' + id }), { deleted: id }));

  // ---- browser, web search, web fetch ----
  add('sandbox_browser_screenshot',
    'Open a page in headless Chromium (Playwright) inside a "browser"-template sandbox, save a PNG to out_path and optionally return the visible page text. Returns title, final_url, HTTP status and the PNG path; fetch the image with sandbox_read_file (encoding base64). For clicks, forms or logins, write a Playwright script with sandbox_write_file and run it with sandbox_exec.',
    {
      id: ID_PROP, url: { type: 'string', description: 'http(s) URL to open.' }, out_path: { type: 'string', description: 'Default /workspace/shot.png' }, full_page: { type: 'boolean' },
      width: { type: 'integer', description: 'Viewport width, default 1280.' }, height: { type: 'integer', description: 'Viewport height, default 720.' },
      wait_until: { type: 'string', enum: WAIT, description: 'Default load.' }, wait_ms: { type: 'integer', description: 'Extra wait after load, max 10000.' }, extract_text: { type: 'boolean', description: 'Also return the page text (cut at 20,000 chars).' },
    }, ['id', 'url'], async (a) => {
      const id = assertId(a.id);
      const url = httpUrl(a.url);
      const outPath = assertAbsPath(a.out_path || '/workspace/shot.png');
      const parsed = await execJob(id, {
        op: 'screenshot', url, out: outPath, full_page: !!a.full_page,
        width: clamp(Math.floor(Number(a.width) || 1280), 200, 3840), height: clamp(Math.floor(Number(a.height) || 720), 200, 2160),
        wait_until: WAIT.includes(a.wait_until) ? a.wait_until : 'load', wait_ms: clamp(Math.floor(Number(a.wait_ms) || 0), 0, 10_000), timeout_ms: 45_000, extract_text: !!a.extract_text,
      }, 90);
      const text = parsed.text !== undefined ? cut(parsed.text) : null;
      return {
        screenshot_path: outPath, status: parsed.status, title: parsed.title, final_url: parsed.final_url,
        ...(text ? { text: text.text, ...(text.truncated ? { text_truncated_from: text.total_chars } : {}) } : {}),
        next: 'Use sandbox_read_file with encoding "base64" to fetch the PNG.',
      };
    });
  add('web_search',
    'Search the web. PandaStack has no search API of its own, so this drives real headless Chromium inside a PandaStack helper sandbox (DuckDuckGo first, Bing as fallback) and returns title, url and snippet per result. fetch_pages (0-3) also reads the text of the top results so you can answer from them. The helper sandbox is created on first use and reused, with one per API key in rotation. Slower than a search API (a few seconds) and a search engine may occasionally show a bot check; then it falls back to the other engine.',
    {
      query: { type: 'string' }, max_results: { type: 'integer', description: '1-10, default 5.' }, engine: { type: 'string', enum: ['duckduckgo', 'bing'], description: 'Preferred engine. Default duckduckgo.' },
      fetch_pages: { type: 'integer', description: 'Also read the text of the first N results (0-3, default 0).' }, page_chars: { type: 'integer', description: 'Characters kept per page, 500-8000, default 3000.' },
    }, ['query'], async (a) => {
      const q = typeof a.query === 'string' ? a.query.trim() : '';
      if (!q || q.length > 400) toolError('query is required (max 400 characters).');
      const id = await helperSandbox();
      const parsed = await execJob(id, {
        op: 'search', query: q, engine: a.engine === 'bing' ? 'bing' : 'duckduckgo', max_results: clamp(Math.floor(Number(a.max_results) || 5), 1, 10),
        fetch_pages: clamp(Math.floor(Number(a.fetch_pages) || 0), 0, 3), page_chars: clamp(Math.floor(Number(a.page_chars) || 3000), 500, 8000), timeout_ms: 25_000,
      }, 150);
      if (!parsed.results || !parsed.results.length) {
        return { query: q, results: [], note: 'No results from any engine (likely a bot check or no matches). Try different words or web_fetch a specific URL.', errors: parsed.errors };
      }
      return { query: q, engine: parsed.engine, results: parsed.results, ...(parsed.errors && parsed.errors.length ? { engine_errors: parsed.errors } : {}) };
    });
  add('web_fetch',
    'Open a URL in real headless Chromium (JavaScript runs, so single-page apps work) inside a PandaStack helper sandbox and return the visible text, title, HTTP status and optionally the links. No sandbox id is needed.',
    {
      url: { type: 'string' }, max_chars: { type: 'integer', description: 'Text kept, 500-50000, default 20000.' }, include_links: { type: 'boolean' },
      wait_until: { type: 'string', enum: WAIT }, wait_ms: { type: 'integer', description: 'Extra wait, max 10000.' },
    }, ['url'], async (a) => {
      const url = httpUrl(a.url);
      const id = await helperSandbox();
      const parsed = await execJob(id, {
        op: 'fetch', url, links: !!a.include_links, wait_until: WAIT.includes(a.wait_until) ? a.wait_until : 'domcontentloaded',
        wait_ms: clamp(Math.floor(Number(a.wait_ms) || 0), 0, 10_000), timeout_ms: 45_000,
      }, 90);
      const t = cut(parsed.text, clamp(Math.floor(Number(a.max_chars) || 20_000), 500, 50_000));
      return {
        url: parsed.final_url || url, status: parsed.status, title: parsed.title, text: t.text, ...(t.truncated ? { text_truncated_from: t.total_chars } : {}),
        ...(parsed.links ? { links: parsed.links } : {}),
      };
    });

  // ---- escape hatch ----
  add('pandastack_api',
    'Call any PandaStack REST endpoint under /v1/ directly, for features that have no dedicated tool or when a dedicated tool\'s path differs on your PandaStack version. Uses the rotating API keys and follows the key that owns a resource. Creating sandboxes or forking must go through sandbox_create / sandbox_fork so limits apply.',
    {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', description: 'e.g. /v1/sandboxes/abc/exec. Must start with /v1/.' },
      query: { type: 'object', description: 'Query-string values.' }, body: { type: 'object', description: 'JSON body.' }, key_slot: SLOT_PROP,
    }, ['method', 'path'], async (a) => {
      const method = String(a.method || '').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) toolError('method must be GET, POST, PUT, PATCH or DELETE.');
      const path = String(a.path || '');
      if (!/^\/v1\/[A-Za-z0-9._~\-/%:@=,+]*$/.test(path) || path.includes('..') || path.includes('//')) toolError('path must start with /v1/ and contain only plain path characters.');
      const clean = path.replace(/\/+$/, '');
      if (method === 'POST' && (clean === '/v1/sandboxes' || /\/fork$/.test(clean))) toolError('Use sandbox_create or sandbox_fork so the sandbox limits apply.');
      const query: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(obj(a.query, 'query'))) if (typeof v === 'string' || typeof v === 'number') query[k] = v;
      const r = await c.request(method, path, { query, json: a.body === undefined ? undefined : obj(a.body, 'body'), affinity: affinityFromPath(path), keySlot: a.key_slot, timeoutMs: 60_000 });
      if (r === null || r === undefined) return { ok: true };
      if (Buffer.isBuffer(r)) return { bytes: r.length };
      const t = cut(r, 50_000);
      return typeof r === 'string' || t.truncated ? { result: t.text, ...(t.truncated ? { truncated_from: t.total_chars } : {}) } : r;
    });

  return T;
}
