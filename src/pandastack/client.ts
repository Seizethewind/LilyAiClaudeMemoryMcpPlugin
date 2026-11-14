/**
 * PandaStack REST client with multi-key rotation.
 *
 * PANDASTACK_API_KEY may hold one key or a comma-separated list ("k1,k2,k3").
 *
 * Rotation rules:
 *  - New work (create a sandbox, create a volume, a web search, ...) goes to the
 *    next key in strict round robin: k1, then k2, then k3, then k1 again.
 *  - A resource belongs to the key that created it, and other keys may belong to
 *    another account and cannot see it. So the client remembers which key owns
 *    each sandbox / volume / database / app / snapshot and sends follow-up calls
 *    with that key. After a restart it forgets, and finds the owner by trying keys
 *    in turn (a 404/403 on a not-yet-owned resource just means "not this key").
 *  - A key that is rejected (401/402) rests for 10 minutes, a key that is rate
 *    limited or out of capacity (429/507/503+Retry-After) rests for its Retry-After
 *    (default 30 s). The call moves on to the next key at once. Refusals like these
 *    happen before anything is created, so moving on is safe. Anything else (a 500,
 *    a timeout) is never retried on another key, because the work may have started.
 *  - Keys never appear in tool results, errors or logs; slots are shown as "key 2/3".
 */

export type FetchFn = typeof fetch;

export const SOURCE_TAG = 'lily-mcp';
export const MAX_OUTPUT_CHARS = 20_000;
const DEAD_STATUSES = new Set(['deleted', 'killed', 'terminated', 'stopped', 'failed', 'expired', 'error']);

export class PandaStackError extends Error {
  status: number;
  retryAfter = 0;
  isToolError = true;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

export function toolError(message: string): never {
  const err: any = new Error(message);
  err.isToolError = true;
  throw err;
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export function cut(text: any, max = MAX_OUTPUT_CHARS) {
  const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
  return s.length > max ? { text: s.slice(0, max), truncated: true, total_chars: s.length } : { text: s, truncated: false, total_chars: s.length };
}

export function assertId(id: any, what = 'sandbox id'): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) toolError(`Invalid ${what}.`);
  return id;
}

export function assertName(name: any, what: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._@-]{1,64}$/.test(name)) toolError(`Invalid ${what}.`);
  return name;
}

export function assertAbsPath(p: any): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 1024 || p.includes('\0')) {
    toolError('path must be an absolute path inside the sandbox, e.g. /workspace/app.py');
  }
  return p;
}

export function enc(s: string) {
  return encodeURIComponent(s);
}

export function cleanMetadata(meta: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta && typeof meta === 'object') {
    for (const [k, v] of Object.entries(meta).slice(0, 16)) {
      if (typeof v === 'string') out[String(k).slice(0, 64)] = v.slice(0, 200);
    }
  }
  out.source = SOURCE_TAG; // always ours, whatever the caller passed
  return out;
}

/** "k1, k2,k3" (or an array) -> ["k1","k2","k3"]; blanks, quotes and repeats dropped, order kept. */
const PLACEHOLDER = /^(not[ _-]?set|unset|none|null|undefined|n\/a|na|changeme|change[ _-]me|placeholder|todo|your[ _-]?key([ _-]?here)?|x{3,})$/i;

export function parseKeys(raw?: string | string[]): string[] {
  // A placeholder such as "not_set" or "not set" means "no key": it must not switch tools on with a fake key.
  if (!Array.isArray(raw) && PLACEHOLDER.test(String(raw ?? '').trim().replace(/^["']+|["']+$/g, ''))) return [];
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = String(p).trim().replace(/^["']+|["']+$/g, '');
    if (k && !PLACEHOLDER.test(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

interface KeyState {
  calls: number;
  failures: number;
  cooldownUntil: number;
  lastStatus: number | null;
}

export class KeyRing {
  private state: KeyState[];
  private cursor = 0;

  constructor(readonly keys: string[], private now: () => number = Date.now) {
    this.state = keys.map(() => ({ calls: 0, failures: 0, cooldownUntil: 0, lastStatus: null }));
  }

  get size() {
    return this.keys.length;
  }

  /**
   * Try-order for a request that is not tied to a key. The first entry advances by one on
   * every call (strict round robin); keys that are resting go to the back, soonest-ready first,
   * and are still listed so a call never fails just because every key is resting.
   */
  order(): number[] {
    const n = this.size;
    const t = this.now();
    const ready: number[] = [];
    const resting: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = (this.cursor + k) % n;
      (this.state[i].cooldownUntil <= t ? ready : resting).push(i);
    }
    resting.sort((a, b) => this.state[a].cooldownUntil - this.state[b].cooldownUntil);
    this.cursor = (this.cursor + 1) % n;
    return [...ready, ...resting];
  }

  ok(i: number) {
    this.state[i].calls++;
    this.state[i].lastStatus = 200;
  }

  fail(i: number, status: number) {
    this.state[i].calls++;
    this.state[i].failures++;
    this.state[i].lastStatus = status;
  }

  rest(i: number, seconds: number, status: number) {
    this.fail(i, status);
    this.state[i].cooldownUntil = this.now() + seconds * 1000;
  }

  status() {
    const t = this.now();
    return this.state.map((s, i) => ({
      key_slot: i + 1,
      state: s.cooldownUntil > t ? 'resting' : 'ready',
      resting_for_seconds: s.cooldownUntil > t ? Math.ceil((s.cooldownUntil - t) / 1000) : 0,
      calls: s.calls,
      failures: s.failures,
      last_status: s.lastStatus,
    }));
  }
}

export interface ClientOptions {
  apiKey?: string | string[];
  apiUrl?: string;
  previewHost?: string;
  maxActive?: number;
  defaultTtlSeconds?: number;
  maxTtlSeconds?: number;
  fetchImpl?: FetchFn;
  /** Injected in tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ReqOpts {
  json?: any;
  body?: Buffer;
  query?: Record<string, string | number>;
  timeoutMs?: number;
  raw?: boolean;
  /** Follow-up call on a known resource: use the key that owns it (e.g. the sandbox id, or "vol:name"). */
  affinity?: string;
  /** 1-based key slot chosen by the caller. */
  keySlot?: number;
  /** Public endpoints (/healthz, /version) need no key. */
  noAuth?: boolean;
  /** Use this bearer instead of the API key (database broker token). Key choice still follows affinity. */
  bearer?: string;
  /** Told which key slot index served the call. */
  onKey?: (index: number) => void;
}

export class PandaStackClient {
  readonly apiUrl: string;
  readonly previewHost: string;
  readonly maxActive: number;
  readonly defaultTtl: number;
  readonly maxTtl: number;
  readonly ring: KeyRing;
  private owner = new Map<string, number>();
  private fetchImpl: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;

  constructor(o: ClientOptions = {}) {
    this.ring = new KeyRing(parseKeys(o.apiKey), o.now);
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

  ownerOf(affinity: string): number | undefined {
    return this.owner.get(affinity);
  }

  setOwner(affinity: string, index: number) {
    if (this.owner.size > 5000) this.owner.delete(this.owner.keys().next().value as string);
    this.owner.set(affinity, index);
  }

  private scrub(text: string) {
    let s = text;
    for (const k of this.ring.keys) if (k.length >= 8) s = s.split(k).join('[key]');
    return s;
  }

  private tryOrder(opts: ReqOpts): number[] {
    if (opts.noAuth) return [0];
    if (opts.keySlot !== undefined) {
      if (!Number.isInteger(opts.keySlot) || opts.keySlot < 1 || opts.keySlot > this.ring.size) {
        toolError(`key_slot must be between 1 and ${this.ring.size}.`);
      }
      return [opts.keySlot - 1];
    }
    if (opts.affinity !== undefined) {
      const o = this.owner.get(opts.affinity);
      if (o !== undefined) return [o];
    }
    return this.ring.order();
  }

  private async once(i: number, method: string, path: string, opts: ReqOpts): Promise<any> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query || {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (!opts.noAuth) headers.Authorization = `Bearer ${opts.bearer ?? this.ring.keys[i]}`;
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
    const slot = this.ring.size > 1 && !opts.noAuth ? ` (key ${i + 1}/${this.ring.size})` : '';
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: ctl.signal });
    } catch (e: any) {
      throw new PandaStackError(this.scrub(`PandaStack request failed${slot}: ${e && e.name === 'AbortError' ? 'timed out' : e.message}`));
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
      const err = new PandaStackError(this.scrub(`PandaStack ${res.status}${slot}: ${msg || res.statusText}`), res.status);
      err.retryAfter = Number(res.headers.get('retry-after')) || 0;
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

  async request(method: string, path: string, opts: ReqOpts = {}): Promise<any> {
    const order = this.tryOrder(opts);
    const unowned = opts.affinity !== undefined && this.owner.get(opts.affinity) === undefined && opts.keySlot === undefined;
    let last: any;
    for (let n = 0; n < order.length; n++) {
      const i = order[n];
      try {
        const out = await this.once(i, method, path, opts);
        if (!opts.noAuth) {
          this.ring.ok(i);
          if (opts.affinity !== undefined) this.setOwner(opts.affinity, i);
          if (opts.onKey) opts.onKey(i);
        }
        return out;
      } catch (e: any) {
        last = e;
        if (opts.noAuth || !(e instanceof PandaStackError) || e.status === 0) throw e;
        const s = e.status;
        const keyProblem = s === 401 || s === 402;
        const capacity = s === 429 || s === 507 || (s === 503 && e.retryAfter > 0);
        const notMine = (s === 404 || s === 403) && unowned;
        if (keyProblem) this.ring.rest(i, 600, s);
        else if (capacity) this.ring.rest(i, clamp(e.retryAfter || 30, 5, 120), s);
        else this.ring.fail(i, s);
        const moveOn = keyProblem || capacity || notMine;
        if (!moveOn || n === order.length - 1) break;
      }
    }
    if (order.length > 1 && last && last.status) last.message += ` [tried ${order.length} keys]`;
    throw last;
  }

  private rows(body: any): any[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === 'object') {
      for (const k of ['sandboxes', 'snapshots', 'volumes', 'databases', 'apps', 'templates', 'deploys', 'items', 'data']) {
        if (Array.isArray(body[k])) return body[k];
      }
    }
    return [];
  }

  /**
   * GET a collection with every key and merge. Keys may be separate accounts, so one key's
   * list is only part of the picture. Rows get key_slot, and ownership is recorded for follow-ups.
   * A key that fails is skipped (reported in errors) unless every key fails.
   */
  async listAll(path: string, opts: { query?: Record<string, string | number>; affinityPrefix?: string; idField?: string } = {}) {
    const rows: any[] = [];
    const errors: { key_slot: number; error: string }[] = [];
    let firstError: any;
    let okCount = 0;
    for (let i = 0; i < this.ring.size; i++) {
      try {
        const body = await this.request('GET', path, { query: opts.query, keySlot: i + 1 });
        okCount++;
        for (const r of this.rows(body)) {
          const row = r && typeof r === 'object' && this.ring.size > 1 ? { ...r, key_slot: i + 1 } : r;
          rows.push(row);
          const idv = row && row[opts.idField || 'id'];
          if (idv !== undefined) this.setOwner(`${opts.affinityPrefix || ''}${idv}`, i);
        }
      } catch (e: any) {
        firstError = firstError || e;
        errors.push({ key_slot: i + 1, error: e.message });
      }
    }
    if (!okCount) throw firstError;
    return { rows, errors };
  }

  isAlive(s: any) {
    return !DEAD_STATUSES.has(String((s && s.status) || '').toLowerCase());
  }

  /** Live sandboxes made by this bridge, plus forks of them (forks carry the parent id in their metadata). */
  countMine(rows: any[]) {
    const alive = rows.filter((s) => s && typeof s === 'object' && this.isAlive(s));
    const ours = new Set<string>(alive.filter((s) => s.metadata && s.metadata.source === SOURCE_TAG && s.id).map((s) => String(s.id)));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of alive) {
        if (!s.id || ours.has(String(s.id))) continue;
        const p = s.metadata && (s.metadata.forked_from || s.metadata.fork_parent_id);
        if (p && ours.has(String(p))) {
          ours.add(String(s.id));
          grew = true;
        }
      }
    }
    return ours.size;
  }

  async activeCount() {
    return this.countMine((await this.listAll('/v1/sandboxes')).rows);
  }

  async assertRoom(extra: number) {
    const active = await this.activeCount();
    if (active + extra > this.maxActive) {
      toolError(
        `Sandbox limit reached (${active}/${this.maxActive} live sandboxes made by this bridge${extra > 1 ? `, ${extra} more requested` : ''}). Delete one with sandbox_delete or raise SANDBOX_MAX_ACTIVE.`
      );
    }
  }

  async create(args: { template?: string; ttl_seconds?: number; metadata?: any; from_snapshot?: string; volumes?: any; key_slot?: number }) {
    const fromSnapshot = args.from_snapshot ? assertId(args.from_snapshot, 'snapshot id') : undefined;
    const template = args.template ? assertName(args.template, 'template name') : fromSnapshot ? undefined : 'browser';
    const ttl = clamp(Math.floor(Number(args.ttl_seconds) || this.defaultTtl), 60, this.maxTtl);
    let volumes: { name: string; read_only: boolean }[] | undefined;
    if (args.volumes !== undefined) {
      if (!Array.isArray(args.volumes) || args.volumes.length > 14) toolError('volumes must be a list of at most 14 {name, read_only} objects.');
      volumes = args.volumes.map((v: any) => ({ name: assertName(v && v.name, 'volume name'), read_only: !!(v && v.read_only) }));
    }
    await this.assertRoom(1);
    // A snapshot or volume only exists under the key that made it, so boot from that key.
    let slot = args.key_slot;
    if (slot === undefined) {
      const hint: number | undefined =
        (fromSnapshot ? this.owner.get('snap:' + fromSnapshot) : undefined) ?? (volumes && volumes.length ? this.owner.get('vol:' + volumes[0].name) : undefined);
      if (hint !== undefined) slot = hint + 1;
    }
    const payload: any = { ttl_seconds: ttl, metadata: cleanMetadata(args.metadata) };
    if (template) payload.template = template;
    if (fromSnapshot) payload.from_snapshot = fromSnapshot;
    if (volumes && volumes.length) payload.volumes = volumes;
    // Capacity refusals (503/507/429 with Retry-After) happen before anything is created, so a retry is safe,
    // and request() already moved on to the other keys. Anything else may have created a sandbox, so it is surfaced.
    let last: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let used = -1;
        const sb = await this.request('POST', '/v1/sandboxes', { json: payload, timeoutMs: 60_000, keySlot: slot, onKey: (i) => (used = i) });
        if (sb && sb.id && used >= 0) this.setOwner(String(sb.id), used);
        return {
          ...sb,
          ttl_seconds: ttl,
          ...(used >= 0 && this.ring.size > 1 ? { key_slot: used + 1 } : {}),
          preview_url_example: sb && sb.id ? this.previewUrl(sb.id, 3000) : undefined,
        };
      } catch (e: any) {
        last = e;
        const retryable = e.status === 507 || ((e.status === 503 || e.status === 429) && e.retryAfter > 0);
        if (!retryable || attempt === 2) break;
        await this.sleep(clamp((e.retryAfter || 1) * 1000, 500, 10_000) + Math.floor(Math.random() * 500));
      }
    }
    throw last;
  }
}
