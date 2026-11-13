/**
 * PandaStack sandbox tools (https://docs.pandastack.ai).
 *
 * PandaStack runs Firecracker microVMs. This module exposes a small, guarded
 * slice of its REST API as MCP tools so Claude can create a throwaway VM, run
 * commands and Playwright/Chromium inside it, move files in and out, and expose
 * a port. The `browser` template ships headless Chromium + Playwright, so the
 * browser tools need no installs.
 *
 * Zero dependencies: uses Node's built-in fetch. The tools are only registered
 * when PANDASTACK_API_KEY is set, like memory is only registered with Turso.
 *
 * Env vars:
 *   PANDASTACK_API_KEY            token from the PandaStack dashboard (pds_...).
 *                                 PANDASTACK_TOKEN is accepted as an alias.
 *   PANDASTACK_API_URL            default https://api.pandastack.ai
 *   PANDASTACK_PREVIEW_HOST       preview URL suffix; default is the API host
 *                                 without its leading "api." (self-hosting: set it)
 *   SANDBOX_MAX_ACTIVE            max live sandboxes this bridge may hold (default 3)
 *   SANDBOX_DEFAULT_TTL_SECONDS   lifetime when the caller gives none (default 900)
 *   SANDBOX_MAX_TTL_SECONDS       hard ceiling on any lifetime (default 3600)
 *
 * Every sandbox this bridge creates is tagged metadata.source = "lily-mcp" so the
 * cap only counts its own sandboxes and never touches anything else in the account.
 */

type FetchFn = typeof fetch;

export interface SandboxOptions {
  apiKey?: string;
  apiUrl?: string;
  previewHost?: string;
  maxActive?: number;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  fetchImpl?: FetchFn;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const SOURCE_TAG = 'lily-mcp';
const MAX_OUTPUT_CHARS = 20_000;
const DEAD_STATUSES = new Set(['deleted', 'killed', 'terminated', 'stopped', 'failed', 'expired', 'error']);

export class PandaStackError extends Error {
  status: number;
  isToolError = true;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function toolError(message: string): never {
  const err: any = new Error(message);
  err.isToolError = true;
  throw err;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function cut(text: string, max = MAX_OUTPUT_CHARS) {
  const s = String(text ?? '');
  return s.length > max ? { text: s.slice(0, max), truncated: true, total_chars: s.length } : { text: s, truncated: false, total_chars: s.length };
}

export function assertId(id: any): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) toolError('Invalid sandbox id.');
  return id;
}

export function assertAbsPath(p: any): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024 || p.includes('\0')) {
    toolError('path must be an absolute path inside the sandbox, e.g. /workspace/app.py');
  }
  return p;
}

function cleanMetadata(meta: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta).slice(0, 16)) {
      if (typeof v === 'string') out[String(k).slice(0, 64)] = v.slice(0, 200);
    }
  }
  out.source = SOURCE_TAG; // always ours, whatever the caller passed
  return out;
}

// Playwright job runner. The job (URL, viewport, ...) is written as JSON and read
// back by this script, so no caller-supplied text is ever spliced into a shell
// command or into code.
const SCREENSHOT_SCRIPT = `
import json, sys
from playwright.sync_api import sync_playwright

job = json.load(open('/workspace/.lily/job.json'))
out = {'ok': False}
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
    try:
        ctx = browser.new_context(viewport={'width': job['width'], 'height': job['height']})
        page = ctx.new_page()
        resp = page.goto(job['url'], wait_until=job['wait_until'], timeout=job['timeout_ms'])
        if job.get('wait_ms'):
            page.wait_for_timeout(job['wait_ms'])
        page.screenshot(path=job['out'], full_page=job['full_page'])
        out = {
            'ok': True,
            'status': resp.status if resp else None,
            'title': page.title(),
            'final_url': page.url,
        }
        if job.get('extract_text'):
            out['text'] = page.inner_text('body')
    finally:
        browser.close()
print(json.dumps(out))
`;

export class PandaStackClient {
  readonly apiUrl: string;
  readonly previewHost: string;
  readonly maxActive: number;
  readonly defaultTtl: number;
  readonly maxTtl: number;
  private apiKey: string;
  private fetchImpl: FetchFn;
  private sleep: (ms: number) => Promise<void>;

  constructor(o: SandboxOptions = {}) {
    this.apiKey = String(o.apiKey ?? '');
    this.apiUrl = (o.apiUrl || 'https://api.pandastack.ai').replace(/\/+$/, '');
    const host = new URL(this.apiUrl).hostname;
    this.previewHost = (o.previewHost || host.replace(/^api\./, '')).replace(/^\.+|\.+$/g, '');
    this.maxActive = Math.max(1, Math.floor(o.maxActive ?? 3));
    this.maxTtl = Math.max(60, Math.floor(o.maxTtlSeconds ?? 3600));
    this.defaultTtl = clamp(Math.floor(o.defaultTtlSeconds ?? 900), 60, this.maxTtl);
    this.fetchImpl = o.fetchImpl || fetch;
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  previewUrl(id: string, port: number) {
    return `https://${port}-${id}.${this.previewHost}`;
  }

  async request(
    method: string,
    path: string,
    opts: { json?: any; body?: Buffer; query?: Record<string, string | number>; timeoutMs?: number; raw?: boolean } = {}
  ): Promise<any> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    let body: any;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = opts.body;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: ctl.signal });
    } catch (e: any) {
      throw new PandaStackError(`PandaStack request failed: ${e && e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let msg = txt.slice(0, 500);
      try {
        const j = JSON.parse(txt);
        msg = [j.error, j.detail].filter(Boolean).join(' - ') || msg;
      } catch {
        /* non-JSON error body, keep the raw text */
      }
      const err = new PandaStackError(`PandaStack ${res.status}: ${msg || res.statusText}`, res.status);
      (err as any).retryAfter = Number(res.headers.get('retry-after')) || 0;
      throw err;
    }
    if (opts.raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private rows(body: any): any[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') return body.sandboxes || body.items || body.data || [];
    return [];
  }

  async list() {
    return this.rows(await this.request('GET', '/v1/sandboxes'));
  }

  private async countMine() {
    const mine = (await this.list()).filter(
      (s: any) => s && s.metadata && s.metadata.source === SOURCE_TAG && !DEAD_STATUSES.has(String(s.status || '').toLowerCase())
    );
    return mine.length;
  }

  async create(args: { template?: string; ttl_seconds?: number; metadata?: any }) {
    const template = args.template || 'browser';
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(template)) toolError('Invalid template name.');
    const ttl = clamp(Math.floor(Number(args.ttl_seconds) || this.defaultTtl), 60, this.maxTtl);
    const active = await this.countMine();
    if (active >= this.maxActive) {
      toolError(`Sandbox limit reached (${active}/${this.maxActive} live sandboxes made by this bridge). Delete one with sandbox_delete or raise SANDBOX_MAX_ACTIVE.`);
    }
    const payload = { template, ttl_seconds: ttl, metadata: cleanMetadata(args.metadata) };
    // Capacity refusals (503/507/429 with Retry-After) happen before anything is created, so a retry is safe.
    // Anything else may have created a sandbox, so it is surfaced, not retried.
    let last: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sb = await this.request('POST', '/v1/sandboxes', { json: payload, timeoutMs: 60_000 });
        return { ...sb, ttl_seconds: ttl, preview_url_example: sb && sb.id ? this.previewUrl(sb.id, 3000) : undefined };
      } catch (e: any) {
        last = e;
        const retryable = (e.status === 503 && e.retryAfter > 0) || e.status === 507 || (e.status === 429 && e.retryAfter > 0);
        if (!retryable || attempt === 2) break;
        await this.sleep(clamp((e.retryAfter || 1) * 1000, 500, 10_000) + Math.floor(Math.random() * 500));
      }
    }
    throw last;
  }
}

export const SANDBOX_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  sandbox_templates: { readOnlyHint: true, openWorldHint: true },
  sandbox_list: { readOnlyHint: true, openWorldHint: true },
  sandbox_get: { readOnlyHint: true, openWorldHint: true },
  sandbox_preview_url: { readOnlyHint: true, openWorldHint: false },
  sandbox_read_file: { readOnlyHint: true, openWorldHint: true },
  sandbox_list_dir: { readOnlyHint: true, openWorldHint: true },
  sandbox_create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sandbox_write_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  sandbox_exec: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  sandbox_browser_screenshot: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  sandbox_delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};

export const SANDBOX_HINT =
  'PandaStack sandboxes (sandbox_* tools): disposable Firecracker microVMs. Use template "browser" for Chromium + Playwright. Create one, work in /workspace, then sandbox_delete it. Sandboxes expire on their own (ttl). Preview URLs are public to anyone who has the link.';

export function sandboxOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxOptions {
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    apiKey: env.PANDASTACK_API_KEY || env.PANDASTACK_TOKEN || '',
    apiUrl: env.PANDASTACK_API_URL || undefined,
    previewHost: env.PANDASTACK_PREVIEW_HOST || undefined,
    maxActive: num(env.SANDBOX_MAX_ACTIVE),
    defaultTtlSeconds: num(env.SANDBOX_DEFAULT_TTL_SECONDS),
    maxTtlSeconds: num(env.SANDBOX_MAX_TTL_SECONDS),
  };
}

const ID_PROP = { type: 'string', description: 'Sandbox id returned by sandbox_create.' };

export function buildSandboxTools(opts: SandboxOptions = sandboxOptionsFromEnv()): any[] {
  if (!opts.apiKey) return [];
  const c = new PandaStackClient(opts);

  return [
    {
      name: 'sandbox_templates',
      description: 'List the PandaStack templates you can boot a sandbox from (e.g. "browser" = Chromium + Playwright, "code-interpreter" = Python + data libs, "base" = Ubuntu with Node/Python/Go/Bun).',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => c.request('GET', '/v1/templates'),
    },
    {
      name: 'sandbox_create',
      description:
        `Boot a disposable PandaStack microVM (about 0.2 s from a snapshot). template defaults to "browser" (headless Chromium + Playwright + Python/Node preinstalled). ttl_seconds sets its lifetime (default ${c.defaultTtl}, max ${c.maxTtl}); it is deleted automatically after that. At most ${c.maxActive} sandboxes made by this bridge can be live at once. Work in /workspace.`,
      inputSchema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Template name. Default "browser".' },
          ttl_seconds: { type: 'integer', description: `Lifetime in seconds, 60 to ${c.maxTtl}.` },
          metadata: { type: 'object', description: 'Optional string tags, e.g. {"job":"login-test"}.' },
        },
        required: [],
      },
      handler: async (args) => c.create(args || {}),
    },
    {
      name: 'sandbox_list',
      description: 'List sandboxes in the PandaStack workspace (all of them, not only the ones this bridge made; ours have metadata.source = "lily-mcp").',
      inputSchema: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ sandboxes: await c.list() }),
    },
    {
      name: 'sandbox_get',
      description: 'Describe one sandbox: status, template, boot time.',
      inputSchema: { type: 'object', properties: { id: ID_PROP }, required: ['id'] },
      handler: async ({ id }) => c.request('GET', `/v1/sandboxes/${encodeURIComponent(assertId(id))}`),
    },
    {
      name: 'sandbox_delete',
      description: 'Permanently delete a sandbox and everything in it. Do this when the work is done.',
      inputSchema: { type: 'object', properties: { id: ID_PROP }, required: ['id'] },
      handler: async ({ id }) => {
        await c.request('DELETE', `/v1/sandboxes/${encodeURIComponent(assertId(id))}`);
        return { deleted: id };
      },
    },
    {
      name: 'sandbox_exec',
      description:
        'Run a shell command in the sandbox (sh -c: pipes, &&, heredocs all work) and wait for it. Returns stdout, stderr, exit_code, duration_ms; each stream is cut at 20,000 characters. There is no separate cwd/env field, so use "cd /workspace/x && ..." and "KEY=value cmd". Always keep timeout_seconds sensible; long-running servers should be started in the background (nohup ... &).',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID_PROP,
          cmd: { type: 'string', description: 'Shell command line.' },
          timeout_seconds: { type: 'integer', description: 'Kill after this many seconds. Default 60, max 300.' },
        },
        required: ['id', 'cmd'],
      },
      handler: async ({ id, cmd, timeout_seconds }) => {
        assertId(id);
        if (typeof cmd !== 'string' || !cmd.trim()) toolError('cmd is required.');
        const t = clamp(Math.floor(Number(timeout_seconds) || 60), 1, 300);
        const r = await c.request('POST', `/v1/sandboxes/${encodeURIComponent(id)}/exec`, {
          json: { cmd, timeout_seconds: t },
          timeoutMs: (t + 15) * 1000,
        });
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
      },
    },
    {
      name: 'sandbox_write_file',
      description: 'Write a file inside the sandbox (parent folders are created, an existing file is overwritten). Use encoding "base64" for binary content. Keep files small (a few MB).',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID_PROP,
          path: { type: 'string', description: 'Absolute path, e.g. /workspace/app.py' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How content is encoded. Default utf8.' },
        },
        required: ['id', 'path', 'content'],
      },
      handler: async ({ id, path, content, encoding }) => {
        assertId(id);
        assertAbsPath(path);
        if (typeof content !== 'string') toolError('content must be a string.');
        const bytes = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
        return c.request('PUT', `/v1/sandboxes/${encodeURIComponent(id)}/fs`, { query: { path }, body: bytes, timeoutMs: 60_000 });
      },
    },
    {
      name: 'sandbox_read_file',
      description: 'Read a file from the sandbox. Returns text (utf8) or base64, cut at max_bytes (default 200000, max 2000000). The whole file is loaded server-side, so for big files cut it with exec (head, tar) first.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID_PROP,
          path: { type: 'string', description: 'Absolute path.' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8. Use base64 for images and other binary files.' },
          max_bytes: { type: 'integer' },
        },
        required: ['id', 'path'],
      },
      handler: async ({ id, path, encoding, max_bytes }) => {
        assertId(id);
        assertAbsPath(path);
        const cap = clamp(Math.floor(Number(max_bytes) || 200_000), 1, 2_000_000);
        const buf: Buffer = await c.request('GET', `/v1/sandboxes/${encodeURIComponent(id)}/fs`, { query: { path }, raw: true, timeoutMs: 60_000 });
        const part = buf.subarray(0, cap);
        return {
          path,
          bytes: buf.length,
          truncated: buf.length > cap,
          encoding: encoding === 'base64' ? 'base64' : 'utf8',
          content: part.toString(encoding === 'base64' ? 'base64' : 'utf8'),
        };
      },
    },
    {
      name: 'sandbox_list_dir',
      description: 'List a directory inside the sandbox.',
      inputSchema: {
        type: 'object',
        properties: { id: ID_PROP, path: { type: 'string', description: 'Absolute directory path. Default /workspace.' } },
        required: ['id'],
      },
      handler: async ({ id, path }) => {
        assertId(id);
        const p = assertAbsPath(path || '/workspace');
        return c.request('GET', `/v1/sandboxes/${encodeURIComponent(id)}/fs/dir`, { query: { path: p } });
      },
    },
    {
      name: 'sandbox_preview_url',
      description:
        'Public HTTPS URL for a port inside the sandbox (something must be listening on it). Anyone holding the link can reach that port until the sandbox is deleted, so treat it as a secret and do not expose anything private.',
      inputSchema: { type: 'object', properties: { id: ID_PROP, port: { type: 'integer', description: '1-65535' } }, required: ['id', 'port'] },
      handler: async ({ id, port }) => {
        assertId(id);
        const n = Number(port);
        if (!Number.isInteger(n) || n < 1 || n > 65535) toolError('port must be an integer from 1 to 65535.');
        return { url: c.previewUrl(id, n), warning: 'Public to anyone with this link until the sandbox is deleted.' };
      },
    },
    {
      name: 'sandbox_browser_screenshot',
      description:
        'Open a page in headless Chromium (Playwright) inside a "browser"-template sandbox, save a PNG to out_path and optionally return the visible page text. Returns title, final_url, HTTP status and the PNG path; fetch the image with sandbox_read_file (encoding base64). For anything fancier (clicks, forms, logins), write a Playwright script with sandbox_write_file and run it with sandbox_exec.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID_PROP,
          url: { type: 'string', description: 'http(s) URL to open.' },
          out_path: { type: 'string', description: 'Where to save the PNG. Default /workspace/shot.png' },
          full_page: { type: 'boolean' },
          width: { type: 'integer', description: 'Viewport width, default 1280.' },
          height: { type: 'integer', description: 'Viewport height, default 720.' },
          wait_until: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Default load.' },
          wait_ms: { type: 'integer', description: 'Extra wait after load, max 10000.' },
          extract_text: { type: 'boolean', description: 'Also return the page text (cut at 20,000 chars).' },
        },
        required: ['id', 'url'],
      },
      handler: async (a) => {
        const id = assertId(a.id);
        let target: URL;
        try {
          target = new URL(String(a.url));
        } catch {
          return toolError('url is not a valid URL.');
        }
        if (target.protocol !== 'http:' && target.protocol !== 'https:') toolError('Only http and https URLs can be opened.');
        const outPath = assertAbsPath(a.out_path || '/workspace/shot.png');
        const job = {
          url: target.toString(),
          out: outPath,
          full_page: !!a.full_page,
          width: clamp(Math.floor(Number(a.width) || 1280), 200, 3840),
          height: clamp(Math.floor(Number(a.height) || 720), 200, 2160),
          wait_until: ['load', 'domcontentloaded', 'networkidle'].includes(a.wait_until) ? a.wait_until : 'load',
          wait_ms: clamp(Math.floor(Number(a.wait_ms) || 0), 0, 10_000),
          timeout_ms: 45_000,
          extract_text: !!a.extract_text,
        };
        const base = `/v1/sandboxes/${encodeURIComponent(id)}`;
        await c.request('PUT', `${base}/fs`, { query: { path: '/workspace/.lily/job.json' }, body: Buffer.from(JSON.stringify(job)) });
        await c.request('PUT', `${base}/fs`, { query: { path: '/workspace/.lily/shot.py' }, body: Buffer.from(SCREENSHOT_SCRIPT.trimStart()) });
        const r = await c.request('POST', `${base}/exec`, { json: { cmd: 'python3 /workspace/.lily/shot.py', timeout_seconds: 90 }, timeoutMs: 105_000 });
        const code = r ? (r.exit_code ?? r.exitCode) : null;
        if (code !== 0) {
          const e = cut(String((r && r.stderr) || (r && r.stdout) || ''), 4000);
          toolError(`Screenshot failed (exit ${code}). Is this a "browser" template sandbox? ${e.text.split('\n').slice(-12).join('\n')}`);
        }
        let parsed: any;
        try {
          parsed = JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}');
        } catch {
          toolError('Screenshot script returned unexpected output.');
        }
        const text = parsed.text !== undefined ? cut(parsed.text) : null;
        return {
          screenshot_path: outPath,
          status: parsed.status,
          title: parsed.title,
          final_url: parsed.final_url,
          ...(text ? { text: text.text, ...(text.truncated ? { text_truncated_from: text.total_chars } : {}) } : {}),
          next: 'Use sandbox_read_file with encoding "base64" to fetch the PNG.',
        };
      },
    },
  ];
}
