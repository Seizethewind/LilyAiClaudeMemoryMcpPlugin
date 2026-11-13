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
  add('sandbox_preview_url', 'Public HTTPS URL for a port inside the sandbox (
