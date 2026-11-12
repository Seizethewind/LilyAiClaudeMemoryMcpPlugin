/**
 * Persistent memory for Claude, organised per repository (owner/name).
 *
 * Flow: memory_start (what happened in this repository before?) -> memory_save
 * (prompt + plan, status "planned") -> do the work -> memory_update (result +
 * status). Search is progressive: memory_search and memory_timeline return
 * compact rows; memory_get returns the full entry.
 *
 * Removal has three levels, each safer than the last is destructive:
 *   - one entry      memory_forget       -> trash, restorable
 *   - one repository memory_wipe_repo    -> two-step confirmation, then trash
 *   - everything     admin page only     -> no MCP tool exists for it
 * Only the admin page can erase for good (empty trash); the trash also expires.
 */
import { randomBytes } from 'node:crypto';

export interface DbResult {
  columns: string[];
  rows: any[];
  lastInsertRowid?: bigint | number | null;
  rowsAffected?: number;
}
export interface Db {
  execute(stmt: { sql: string; args?: any[] }): Promise<DbResult>;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
}

const STATUSES = ['planned', 'done', 'partial', 'failed'] as const;
type Status = (typeof STATUSES)[number];
const MAX_FIELD = 8000;
const MAX_TITLE = 200;

// ---------------------------------------------------------------------------
// Secret redaction (prompts can contain tokens; never store them)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED:private-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{20,}=*/gi, '$1[REDACTED]'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*)(?!\[REDACTED)\S{6,}/gi, '$1[REDACTED]'],
];

export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => {
      count++;
      return repl.replace(/\$(\d)/g, (_x, i) => m[Number(i)] ?? '');
    });
  }
  return { text: out, count };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS memories (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     project    TEXT NOT NULL DEFAULT 'general',
     title      TEXT NOT NULL,
     prompt     TEXT NOT NULL,
     plan       TEXT,
     result     TEXT,
     status     TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','done','partial','failed')),
     tags       TEXT,
     pinned     INTEGER NOT NULL DEFAULT 0,
     supersedes INTEGER REFERENCES memories(id),
     deleted_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes)`,
  `CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `INSERT OR IGNORE INTO schema_versions(version) VALUES (1)`,
];

const FTS_SQL = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
     title, prompt, plan, result, tags, content='memories', content_rowid='id'
   )`,
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags)
     VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags)
     VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags)
     VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags);
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags)
     VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags);
   END`,
];


// Schema v2: repository scope, trash, confirmations, audit. The legacy
// "project" column keeps its name but now always holds a canonical repository
// key ("owner/name", lowercase) or "general".
const V2_SQL = [
  `ALTER TABLE memories ADD COLUMN delete_batch TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_memories_batch ON memories(delete_batch)`,
  `CREATE TABLE IF NOT EXISTS repos (
     repo           TEXT PRIMARY KEY,
     display        TEXT NOT NULL,
     locked         INTEGER NOT NULL DEFAULT 0,
     created_at     TEXT NOT NULL DEFAULT (datetime('now')),
     last_active_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS confirmations (
     token      TEXT PRIMARY KEY,
     action     TEXT NOT NULL,
     repo       TEXT NOT NULL,
     count      INTEGER NOT NULL,
     expires_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS memory_audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     TEXT NOT NULL DEFAULT (datetime('now')),
     actor  TEXT NOT NULL,
     action TEXT NOT NULL,
     repo   TEXT,
     detail TEXT
   )`,
];

// ---------------------------------------------------------------------------
// Repositories: every entry belongs to exactly one, identified by owner/name
// ---------------------------------------------------------------------------

export const GENERAL = 'general';
const REPO_KEY_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const REPO_HELP =
  'Pass the repository as "owner/name" (a github.com URL also works), or "general" when the work belongs to no repository. Call memory_repos to see which repositories have memory.';

export function isRepoKey(s: string): boolean {
  return REPO_KEY_RE.test(s) && !/^\.{1,2}$/.test(s.split('/')[1] ?? '');
}

/** Canonical form of a repository: lowercase "owner/name" key plus the spelling the caller used. */
export function normalizeRepo(input: unknown): { key: string; display: string } {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error(`repo is required. ${REPO_HELP}`);
  if (raw.toLowerCase() === GENERAL) return { key: GENERAL, display: GENERAL };
  let s = raw;
  let fromUrl = false;
  const m = s.match(/^(?:git@github\.com:|(?:https?:\/\/|ssh:\/\/git@)?(?:www\.)?github\.com\/)(.+)$/i);
  if (m) { s = m[1]; fromUrl = true; }
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  const bad = () => new Error(`"${raw.slice(0, 80)}" is not a valid repository name. ${REPO_HELP}`);
  if (parts.length < 2 || (parts.length > 2 && !fromUrl)) throw bad();
  const name = parts[1].replace(/\.git$/i, '');
  const key = `${parts[0]}/${name}`.toLowerCase();
  if (!isRepoKey(key)) throw bad();
  return { key, display: `${parts[0]}/${name}` };
}

function lev(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Known repositories that look like the same one under a typo, another owner, or a near-identical name. */
export function similarRepos(key: string, known: { repo: string; display: string }[]): { repo: string; why: string }[] {
  const [o, n] = key.split('/');
  const out: { repo: string; why: string }[] = [];
  for (const k of known) {
    if (k.repo === key || k.repo === GENERAL) continue;
    const [ko, kn] = k.repo.split('/');
    const limit = n.length <= 4 ? 1 : 2;
    let why = '';
    if (kn === n) why = 'same repository name under a different owner';
    else if (ko === o && lev(n, kn) <= limit) why = 'same owner, near-identical name (typo?)';
    else if (lev(key, k.repo) <= 2) why = 'near-identical full name (typo?)';
    if (why) out.push({ repo: k.display, why });
  }
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const COMPACT_COLS = `m.id, m.project AS repo, m.title, m.status, m.pinned, m.created_at, m.updated_at,
  substr(COALESCE(m.result, m.plan, m.prompt), 1, 160) AS snippet,
  (SELECT s.id FROM memories s WHERE s.supersedes = m.id AND s.deleted_at IS NULL LIMIT 1) AS superseded_by`;

const FULL_COLS = `m.id, m.project AS repo, m.title, m.prompt, m.plan, m.result, m.status, m.tags, m.pinned,
  m.supersedes, m.created_at, m.updated_at,
  (SELECT s.id FROM memories s WHERE s.supersedes = m.id AND s.deleted_at IS NULL LIMIT 1) AS superseded_by`;

function clean(v: unknown, max: number): { text: string | null; redactions: number } {
  if (v === undefined || v === null) return { text: null, redactions: 0 };
  const s = String(v).trim();
  if (!s) return { text: null, redactions: 0 };
  // Redact BEFORE truncating: a secret straddling the cut would otherwise be
  // shortened below its pattern's minimum length and be stored in part.
  const r = redact(s);
  const text = r.text.length > max ? r.text.slice(0, max) + ' …[truncated]' : r.text;
  return { text, redactions: r.count };
}

const MAX_TAG = 40;

function toTags(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const t = arr
    .map((x) => (clean(x, MAX_TAG).text ?? '').toLowerCase()) // redact first: patterns are case-sensitive
    .filter(Boolean)
    .slice(0, 12);
  return t.length ? t.join(',') : null;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const affected = (rs: DbResult): number => Number((rs as any).rowsAffected ?? 0);
const sameText = (a: unknown, b: unknown) => String(a ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === String(b ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const batchId = (prefix: string) => prefix + randomBytes(4).toString('hex');

const CONFIRM_MINUTES = 10;

export type Actor = 'claude' | 'admin' | 'system';

export interface RepoSummary {
  repo: string;
  locked: boolean;
  last_active_at: string | null;
  entries: number;
  unfinished: number;
  in_trash: number;
}

export class MemoryStore {
  ftsEnabled = false;
  /** How long removed entries stay restorable in the trash before they are erased for good. */
  trashDays: number;

  constructor(private db: Db, opts: { trashDays?: number } = {}) {
    this.trashDays = Math.max(1, Math.trunc(opts.trashDays ?? 30));
  }

  private async rows(stmt: { sql: string; args?: any[] }): Promise<Record<string, any>[]> {
    const rs = await this.db.execute(stmt);
    return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  }

  private run(sql: string, args: any[] = []): Promise<DbResult> {
    return this.db.execute({ sql, args });
  }

  async init(): Promise<void> {
    for (const sql of SCHEMA_SQL) await this.db.execute({ sql });
    try {
      for (const sql of FTS_SQL) await this.db.execute({ sql });
      this.ftsEnabled = true;
    } catch (err: any) {
      // Fall back to LIKE search rather than refusing to start.
      console.error(`[memory] FTS5 unavailable, using LIKE search: ${err.message}`);
      this.ftsEnabled = false;
    }
    await this.migrate();
  }

  /** v2: entries become repository-scoped. Legacy "project" labels are folded into "general" (kept as a tag). */
  private async migrate(): Promise<void> {
    const v = await this.rows({ sql: 'SELECT MAX(version) AS v FROM schema_versions' });
    if (Number(v[0]?.v ?? 0) >= 2) return;
    for (const sql of V2_SQL) {
      try {
        await this.run(sql);
      } catch (err: any) {
        if (!/duplicate column|already exists/i.test(String(err.message))) throw err;
      }
    }
    const addTag = `tags = CASE WHEN tags IS NULL OR tags = '' THEN ? ELSE tags || ',' || ? END`;
    const projects = await this.rows({ sql: 'SELECT DISTINCT project FROM memories' });
    for (const { project } of projects) {
      const p = String(project);
      if (p === GENERAL || isRepoKey(p)) continue;
      if (p === 'repo-breakdown') {
        // Breakdown entries stored the repository as their first tag: move them under that repository.
        for (const r of await this.rows({ sql: 'SELECT id, tags FROM memories WHERE project = ?', args: [p] })) {
          const tags = String(r.tags ?? '').split(',').filter(Boolean);
          const target = tags.length && isRepoKey(tags[0]) ? tags[0] : GENERAL;
          const rest = target === GENERAL ? tags : tags.slice(1);
          await this.run('UPDATE memories SET project = ?, tags = ? WHERE id = ?', [target, [...rest, 'breakdown'].slice(0, 12).join(','), r.id]);
        }
        continue;
      }
      const label = `legacy-project:${p.replace(/[,\s]+/g, '-').slice(0, 40)}`;
      await this.run(`UPDATE memories SET project = ?, ${addTag} WHERE project = ?`, [GENERAL, label, label, p]);
    }
    await this.run(`INSERT OR IGNORE INTO repos(repo, display) VALUES ('${GENERAL}', '${GENERAL}')`);
    await this.run('INSERT OR IGNORE INTO repos(repo, display) SELECT DISTINCT project, project FROM memories');
    await this.run('INSERT OR IGNORE INTO schema_versions(version) VALUES (2)');
  }

  // ---- helpers ------------------------------------------------------------

  private async audit(actor: Actor, action: string, repo: string | null, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.run('INSERT INTO memory_audit(actor, action, repo, detail) VALUES (?,?,?,?)', [actor, action, repo, JSON.stringify(detail)]);
    } catch (err: any) {
      console.error(`[memory] audit write failed: ${err.message}`); // never block the operation on this
    }
  }

  private async repoRow(key: string) {
    return (await this.rows({ sql: 'SELECT repo, display, locked, created_at, last_active_at FROM repos WHERE repo = ?', args: [key] }))[0];
  }

  private async similar(key: string) {
    return similarRepos(key, (await this.rows({ sql: 'SELECT repo, display FROM repos' })) as any);
  }

  private async touchRepo(key: string): Promise<void> {
    await this.run(`UPDATE repos SET last_active_at = datetime('now') WHERE repo = ?`, [key]);
  }

  // ---- working with a repository -----------------------------------------

  /** First call of every piece of work: what has happened in this repository before? */
  async start(a: any) {
    const { key, display } = normalizeRepo(a.repo);
    const row = await this.repoRow(key);
    if (!row) {
      const similar = await this.similar(key);
      return {
        repo: display,
        known: false,
        similar,
        next: similar.length
          ? 'No memory for this exact repository yet. If one of the similar repositories is the one you mean, use its exact name. If this really is a new repository, start with memory_save and pass confirm_new_repo: true.'
          : 'No memory for this repository yet. Start with memory_save.',
      };
    }
    const byStatus = await this.rows({ sql: 'SELECT status, COUNT(*) AS n FROM memories WHERE project = ? AND deleted_at IS NULL GROUP BY status', args: [key] });
    const list = (extra: string, limit: number) =>
      this.rows({ sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE m.project = ? AND m.deleted_at IS NULL ${extra} ORDER BY m.id DESC LIMIT ?`, args: [key, limit] });
    const unfinished = await list(`AND m.status = 'planned'`, 5);
    const pinned = await list('AND m.pinned = 1', 10);
    const recent = await list('', 8);
    const trash = await this.rows({ sql: 'SELECT COUNT(*) AS n FROM memories WHERE project = ? AND deleted_at IS NOT NULL', args: [key] });
    const total = byStatus.reduce((s, r) => s + Number(r.n), 0);
    return {
      repo: row.display,
      known: true,
      locked: !!row.locked,
      entries: total,
      by_status: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      in_trash: Number(trash[0]?.n ?? 0),
      last_active: row.last_active_at ?? null,
      unfinished,
      pinned,
      recent,
      next: 'Use memory_get for full entries or memory_search to dig deeper. Then memory_save before the work, memory_update after.',
    };
  }

  async save(a: any) {
    const { key, display } = normalizeRepo(a.repo);
    const prompt = clean(a.prompt, MAX_FIELD);
    if (!prompt.text) throw new Error('prompt is required');
    const plan = clean(a.plan, MAX_FIELD);
    const titleSrc = a.title ?? prompt.text.replace(/\s+/g, ' ').slice(0, 80);
    const title = clean(titleSrc, MAX_TITLE);
    let supersedes: number | null = null;
    if (a.supersedes !== undefined && a.supersedes !== null) {
      supersedes = clampInt(a.supersedes, 0, 1, Number.MAX_SAFE_INTEGER);
      const exists = await this.rows({ sql: 'SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL', args: [supersedes] });
      if (!exists.length) throw new Error(`supersedes: memory ${supersedes} not found`);
    }
    const existing = await this.repoRow(key);
    if (!existing) {
      // Repositories cannot have look-alike names: a typo must not silently open a second scope.
      const similar = await this.similar(key);
      if (similar.length && a.confirm_new_repo !== true) {
        throw new Error(
          `"${display}" has no memory yet, but similar repositories do: ${similar.map((s) => `${s.repo} (${s.why})`).join('; ')}. ` +
            `If you meant one of them, use its exact name. If this really is a new repository, call memory_save again with confirm_new_repo: true.`
        );
      }
      await this.run('INSERT OR IGNORE INTO repos(repo, display) VALUES (?, ?)', [key, display]);
    }
    const rs = await this.run(
      `INSERT INTO memories (project,title,prompt,plan,tags,pinned,supersedes) VALUES (?,?,?,?,?,?,?)`,
      [key, title.text, prompt.text, plan.text, toTags(a.tags), a.pinned ? 1 : 0, supersedes]
    );
    await this.touchRepo(key);
    return {
      id: Number(rs.lastInsertRowid),
      repo: existing?.display ?? display,
      created_repo: !existing,
      status: 'planned',
      redactions: prompt.redactions + plan.redactions + title.redactions,
      next: 'When the work is done, call memory_update with this id, the result, and a status (done/partial/failed).',
    };
  }

  async update(a: any) {
    const id = clampInt(a.id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new Error('id is required');
    const cur = await this.rows({ sql: 'SELECT project FROM memories WHERE id = ? AND deleted_at IS NULL', args: [id] });
    if (!cur.length) throw new Error(`memory ${id} not found`);
    if (a.repo !== undefined) {
      const { key } = normalizeRepo(a.repo);
      if (cur[0].project !== key) throw new Error(`memory ${id} belongs to ${cur[0].project}, not ${key}; nothing changed.`);
    }
    const sets: string[] = [];
    const args: any[] = [];
    let redactions = 0;
    const text = (col: string, v: unknown, max: number) => {
      if (v === undefined) return;
      const c = clean(v, max);
      redactions += c.redactions;
      sets.push(`${col} = ?`);
      args.push(c.text);
    };
    if (a.result !== undefined && a.append_result !== undefined) throw new Error('pass either result or append_result, not both');
    text('result', a.result, MAX_FIELD);
    if (a.append_result !== undefined) {
      // Add to the existing result on a new line (capped at MAX_FIELD in total).
      const c = clean(a.append_result, MAX_FIELD);
      if (c.text) {
        redactions += c.redactions;
        sets.push(`result = substr(CASE WHEN result IS NULL OR result = '' THEN ? ELSE result || char(10) || ? END, 1, ${MAX_FIELD})`);
        args.push(c.text, c.text);
      }
    }
    text('plan', a.plan, MAX_FIELD);
    if (a.title !== undefined) {
      const t = clean(a.title, MAX_TITLE);
      if (t.text) { sets.push('title = ?'); args.push(t.text); redactions += t.redactions; }
    }
    if (a.tags !== undefined) { sets.push('tags = ?'); args.push(toTags(a.tags)); }
    if (a.pinned !== undefined) { sets.push('pinned = ?'); args.push(a.pinned ? 1 : 0); }
    let status: Status | undefined = a.status;
    if (status === undefined && a.result !== undefined) status = 'done';
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new Error(`status must be one of: ${STATUSES.join(', ')}`);
      sets.push('status = ?');
      args.push(status);
    }
    if (!sets.length) throw new Error('nothing to update');
    sets.push(`updated_at = datetime('now')`);
    args.push(id);
    const rs = await this.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, args);
    if (!affected(rs)) throw new Error(`memory ${id} not found`);
    await this.touchRepo(cur[0].project);
    return { id, repo: cur[0].project, updated: true, status: status ?? 'unchanged', redactions };
  }

  async search(a: any) {
    const q = String(a.query ?? '').trim();
    if (!q) throw new Error('query is required');
    const limit = clampInt(a.limit, 10, 1, 30);
    const tokens = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!tokens.length) return { count: 0, results: [] };
    const filters: string[] = ['m.deleted_at IS NULL'];
    const fargs: any[] = [];
    if (a.repo) { filters.push('m.project = ?'); fargs.push(normalizeRepo(a.repo).key); }
    if (a.status) { filters.push('m.status = ?'); fargs.push(String(a.status)); }
    const where = filters.join(' AND ');

    if (this.ftsEnabled) {
      const run = (match: string) =>
        this.rows({
          sql: `SELECT ${COMPACT_COLS} FROM memories_fts f JOIN memories m ON m.id = f.rowid
                WHERE memories_fts MATCH ? AND ${where}
                ORDER BY bm25(memories_fts, 10.0, 2.0, 1.0, 3.0, 5.0) LIMIT ?`, // columns: title, prompt, plan, result, tags
          args: [match, ...fargs, limit],
        });
      const quoted = tokens.map((t) => `"${t}"*`);
      let results = await run(quoted.join(' '));
      if (!results.length && tokens.length > 1) results = await run(quoted.join(' OR '));
      return { count: results.length, results };
    }
    const like = tokens.map(() => `(m.title || ' ' || m.prompt || ' ' || COALESCE(m.plan,'') || ' ' || COALESCE(m.result,'') || ' ' || COALESCE(m.tags,'')) LIKE ?`);
    const results = await this.rows({
      sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE ${where} AND ${like.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      args: [...fargs, ...tokens.map((t) => `%${t}%`), limit],
    });
    return { count: results.length, results };
  }

  async timeline(a: any) {
    const limit = clampInt(a.limit, 15, 1, 50);
    const repoKey = a.repo ? normalizeRepo(a.repo).key : null;
    const filters: string[] = ['m.deleted_at IS NULL'];
    const args: any[] = [];
    if (repoKey) { filters.push('m.project = ?'); args.push(repoKey); }
    if (a.status) { filters.push('m.status = ?'); args.push(String(a.status)); }
    if (a.before_id) { filters.push('m.id < ?'); args.push(clampInt(a.before_id, 0, 1, Number.MAX_SAFE_INTEGER)); }
    const results = await this.rows({
      sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE ${filters.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      args: [...args, limit],
    });
    const pinned = a.before_id ? [] : await this.rows({
      sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE m.deleted_at IS NULL AND m.pinned = 1 ${repoKey ? 'AND m.project = ?' : ''} ORDER BY m.id DESC LIMIT 10`,
      args: repoKey ? [repoKey] : [],
    });
    return { pinned, count: results.length, results, next_before_id: results.length === limit ? results[results.length - 1].id : null };
  }

  async get(a: any) {
    const ids: number[] = (Array.isArray(a.ids) ? a.ids : [a.id ?? a.ids]).map((x: unknown) => clampInt(x, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean).slice(0, 10);
    if (!ids.length) throw new Error('id or ids is required');
    const rows = await this.rows({
      sql: `SELECT ${FULL_COLS} FROM memories m WHERE m.id IN (${ids.map(() => '?').join(',')}) AND m.deleted_at IS NULL ORDER BY m.id`,
      args: ids,
    });
    return { count: rows.length, memories: rows };
  }

  /** Which repositories have memory, and how much. */
  async repos(a: any = {}) {
    const q = String(a.query ?? '').trim().toLowerCase();
    const rows = await this.listRepos(200);
    const out = q ? rows.filter((r) => r.repo.toLowerCase().includes(q)) : rows;
    return { count: out.length, repos: out.slice(0, 50) };
  }

  private async listRepos(limit: number): Promise<RepoSummary[]> {
    const rows = await this.rows({
      sql: `SELECT r.display AS repo, r.locked, r.last_active_at,
              (SELECT COUNT(*) FROM memories m WHERE m.project = r.repo AND m.deleted_at IS NULL) AS entries,
              (SELECT COUNT(*) FROM memories m WHERE m.project = r.repo AND m.deleted_at IS NULL AND m.status = 'planned') AS unfinished,
              (SELECT COUNT(*) FROM memories m WHERE m.project = r.repo AND m.deleted_at IS NOT NULL) AS in_trash
            FROM repos r ORDER BY COALESCE(r.last_active_at, r.created_at) DESC, r.repo LIMIT ?`,
      args: [limit],
    });
    return rows.map((r) => ({
      repo: String(r.repo),
      locked: !!r.locked,
      last_active_at: (r.last_active_at as string | null) ?? null,
      entries: Number(r.entries),
      unfinished: Number(r.unfinished),
      in_trash: Number(r.in_trash),
    }));
  }

  // ---- removal: single entry -> trash -------------------------------------

  /** Remove ONE entry of a repository. It moves to the trash and can be restored until the trash is emptied. */
  async forget(a: any, actor: Actor = 'claude') {
    const { key } = normalizeRepo(a.repo);
    const id = clampInt(a.id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new Error('id is required');
    const row = (await this.rows({ sql: 'SELECT project, pinned FROM memories WHERE id = ? AND deleted_at IS NULL', args: [id] }))[0];
    if (!row) throw new Error(`memory ${id} not found`);
    if (row.project !== key) throw new Error(`memory ${id} belongs to ${row.project}, not ${key}; nothing removed.`);
    if (row.pinned) throw new Error(`memory ${id} is pinned. Unpin it first (memory_update with pinned: false) if the user really wants it removed.`);
    const batch = batchId('e');
    const rs = await this.run(
      `UPDATE memories SET deleted_at = datetime('now'), delete_batch = ?, updated_at = datetime('now') WHERE id = ? AND project = ? AND pinned = 0 AND deleted_at IS NULL`,
      [batch, id, key]
    );
    if (!affected(rs)) throw new Error(`memory ${id} could not be removed`);
    await this.audit(actor, 'forget_entry', key, { id, batch });
    return { id, repo: key, removed: true, where: `trash (restorable for ${this.trashDays} days)`, batch, undo: `memory_restore with repo "${key}" and id ${id}` };
  }

  async restore(a: any, actor: Actor = 'claude') {
    const { key, display } = normalizeRepo(a.repo);
    let rs: DbResult;
    const set = `UPDATE memories SET deleted_at = NULL, delete_batch = NULL, updated_at = datetime('now')`;
    if (a.batch) rs = await this.run(`${set} WHERE delete_batch = ? AND project = ? AND deleted_at IS NOT NULL`, [String(a.batch), key]);
    else if (a.id) rs = await this.run(`${set} WHERE id = ? AND project = ? AND deleted_at IS NOT NULL`, [clampInt(a.id, 0, 1, Number.MAX_SAFE_INTEGER), key]);
    else throw new Error('pass id (one entry) or batch (everything removed together) from memory_trash');
    const n = affected(rs);
    if (!n) throw new Error(`nothing in the trash of ${key} matches that id/batch (it may have been erased already)`);
    await this.run('INSERT OR IGNORE INTO repos(repo, display) VALUES (?, ?)', [key, display]);
    await this.audit(actor, 'restore', key, { id: a.id ?? null, batch: a.batch ?? null, restored: n });
    return { repo: key, restored: n };
  }

  /** What is in the trash, grouped by removal batch. */
  async trash(a: any = {}) {
    const key = a.repo ? normalizeRepo(a.repo).key : null;
    const cond = key ? 'AND project = ?' : '';
    const args = key ? [key] : [];
    const batches = await this.rows({
      sql: `SELECT delete_batch AS batch, project AS repo, COUNT(*) AS entries, MIN(deleted_at) AS removed_at
            FROM memories WHERE deleted_at IS NOT NULL ${cond} GROUP BY delete_batch, project ORDER BY removed_at DESC LIMIT 30`,
      args,
    });
    const day = 86400000;
    const withExpiry = batches.map((b) => ({
      ...b,
      entries: Number(b.entries),
      erased_after: new Date(new Date(String(b.removed_at).replace(' ', 'T') + 'Z').getTime() + this.trashDays * day).toISOString().slice(0, 10),
    }));
    const entries = key
      ? await this.rows({ sql: `SELECT id, title, delete_batch AS batch, deleted_at FROM memories WHERE deleted_at IS NOT NULL AND project = ? ORDER BY deleted_at DESC, id DESC LIMIT 20`, args: [key] })
      : [];
    return { retention_days: this.trashDays, batches: withExpiry, entries };
  }

  // ---- removal: one repository -> trash, behind a two-step confirmation ----

  /**
   * Step 1 (no confirm_token): nothing is changed; returns a preview, a one-time
   * token and the exact phrase the user has to confirm.
   * Step 2 (with token + phrase): moves the repository's entries to the trash.
   * Locked repositories are refused; pinned entries are skipped unless include_pinned.
   */
  async wipeRepo(a: any, actor: Actor = 'claude') {
    const { key } = normalizeRepo(a.repo);
    const repo = await this.repoRow(key);
    if (!repo) throw new Error(`no memory exists for ${key}`);
    if (repo.locked) throw new Error(`${repo.display} is locked against wipes. Only the user can unlock it, from the server's admin page (/admin/memory).`);
    const includePinned = a.include_pinned === true;
    const action = includePinned ? 'wipe_repo+pinned' : 'wipe_repo';
    const pinClause = includePinned ? '' : 'AND pinned = 0';
    const n = Number((await this.rows({ sql: `SELECT COUNT(*) AS n FROM memories WHERE project = ? AND deleted_at IS NULL ${pinClause}`, args: [key] }))[0].n);
    const phrase = `WIPE ${key} ${n}`;

    if (!a.confirm_token) {
      const pinned = Number((await this.rows({ sql: 'SELECT COUNT(*) AS n FROM memories WHERE project = ? AND deleted_at IS NULL AND pinned = 1', args: [key] }))[0].n);
      if (!n) return { repo: key, preview: true, entries: 0, note: 'Nothing to wipe' + (pinned ? ` (${pinned} pinned entries are protected; pass include_pinned: true to include them).` : '.') };
      const stats = (await this.rows({ sql: `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM memories WHERE project = ? AND deleted_at IS NULL ${pinClause}`, args: [key] }))[0];
      const byStatus = await this.rows({ sql: `SELECT status, COUNT(*) AS n FROM memories WHERE project = ? AND deleted_at IS NULL ${pinClause} GROUP BY status`, args: [key] });
      const sample = await this.rows({ sql: `SELECT id, title FROM memories WHERE project = ? AND deleted_at IS NULL ${pinClause} ORDER BY id DESC LIMIT 5`, args: [key] });
      const token = randomBytes(8).toString('hex');
      await this.run(`DELETE FROM confirmations WHERE expires_at < ?`, [new Date().toISOString()]);
      await this.run('INSERT INTO confirmations(token, action, repo, count, expires_at) VALUES (?,?,?,?,?)', [
        token, action, key, n, new Date(Date.now() + CONFIRM_MINUTES * 60000).toISOString(),
      ]);
      await this.audit(actor, 'wipe_repo_preview', key, { entries: n });
      return {
        repo: key,
        preview: true,
        entries: n,
        by_status: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        oldest: stats.oldest,
        newest: stats.newest,
        newest_titles: sample,
        pinned_skipped: includePinned ? 0 : pinned,
        confirm_token: token,
        confirm_phrase: phrase,
        expires_in_minutes: CONFIRM_MINUTES,
        instructions:
          `STOP. Show this preview to the user and ask whether to wipe ${n} entries of ${key}. Only if the user explicitly says yes in their own words, call memory_wipe_repo again with repo, confirm_token and confirm_phrase. ` +
          `Never confirm on your own. Entries go to the trash and can be restored for ${this.trashDays} days.`,
      };
    }

    const row = (await this.rows({ sql: 'SELECT token, action, repo, count, expires_at FROM confirmations WHERE token = ?', args: [String(a.confirm_token)] }))[0];
    if (!row) throw new Error('confirm_token is unknown, expired or already used. Run memory_wipe_repo without a token to get a new preview.');
    if (row.repo !== key || row.action !== action) throw new Error('confirm_token belongs to a different wipe request. Run memory_wipe_repo again for a fresh preview.');
    if (String(row.expires_at) < new Date().toISOString()) throw new Error('confirm_token has expired. Run memory_wipe_repo again for a fresh preview.');
    if (Number(row.count) !== n) {
      await this.run('DELETE FROM confirmations WHERE token = ?', [row.token]); // stale for good
      throw new Error(`The repository changed since the preview (${row.count} -> ${n} entries). Nothing was wiped; run memory_wipe_repo again for a fresh preview.`);
    }
    if (!sameText(a.confirm_phrase, phrase)) throw new Error(`confirm_phrase must be exactly: ${phrase}`);
    // Single use: consume the token before acting, so a repeated call cannot wipe twice.
    if (affected(await this.run('DELETE FROM confirmations WHERE token = ?', [row.token])) !== 1) throw new Error('confirm_token was already used.');
    const batch = batchId('w');
    const rs = await this.run(
      `UPDATE memories SET deleted_at = datetime('now'), delete_batch = ?, updated_at = datetime('now') WHERE project = ? AND deleted_at IS NULL ${pinClause}`,
      [batch, key]
    );
    const done = affected(rs);
    await this.audit(actor, 'wipe_repo', key, { entries: done, batch, include_pinned: includePinned });
    return { repo: key, wiped: done, where: `trash (restorable for ${this.trashDays} days)`, batch, undo: `memory_restore with repo "${key}" and batch "${batch}"` };
  }

  /** Locking is always safe, so Claude may do it. Unlocking is admin-only (unlockRepo). */
  async lockRepo(a: any, actor: Actor = 'claude') {
    const { key } = normalizeRepo(a.repo);
    if (!affected(await this.run('UPDATE repos SET locked = 1 WHERE repo = ?', [key]))) throw new Error(`no memory exists for ${key}`);
    await this.audit(actor, 'lock', key);
    return { repo: key, locked: true, note: 'Wipes and renames are refused until the user unlocks it from the admin page.' };
  }

  async unlockRepo(key: string, actor: Actor = 'admin') {
    if (!affected(await this.run('UPDATE repos SET locked = 0 WHERE repo = ?', [key]))) throw new Error(`no memory exists for ${key}`);
    await this.audit(actor, 'unlock', key);
    return { repo: key, locked: false };
  }

  /** Fix a repository that was saved under a wrong name (typo) or was renamed on GitHub. Never merges two repositories. */
  async renameRepo(a: any, actor: Actor = 'claude') {
    const from = normalizeRepo(a.from);
    const to = normalizeRepo(a.to);
    if (from.key === GENERAL || to.key === GENERAL) throw new Error('"general" cannot be renamed or used as a rename target');
    const row = await this.repoRow(from.key);
    if (!row) throw new Error(`no memory exists for ${from.key}`);
    if (row.locked) throw new Error(`${row.display} is locked. Only the user can unlock it, from the admin page.`);
    if (from.key === to.key) {
      await this.run('UPDATE repos SET display = ? WHERE repo = ?', [to.display, to.key]);
      return { repo: to.key, renamed: false, note: 'Same repository; only the spelling was updated.' };
    }
    if (await this.repoRow(to.key)) throw new Error(`${to.display} already has memory. Repositories are never merged automatically.`);
    await this.run('INSERT INTO repos(repo, display, created_at, last_active_at) SELECT ?, ?, created_at, last_active_at FROM repos WHERE repo = ?', [to.key, to.display, from.key]);
    await this.run('UPDATE memories SET project = ? WHERE project = ?', [to.key, from.key]);
    await this.run('DELETE FROM repos WHERE repo = ?', [from.key]);
    await this.audit(actor, 'rename', from.key, { to: to.key });
    return { from: from.key, to: to.key, renamed: true };
  }

  // ---- admin level (never exposed as an MCP tool) --------------------------

  async adminSummary() {
    const repos = await this.listRepos(200);
    const trash = await this.trash({});
    const audit = await this.rows({ sql: 'SELECT at, actor, action, repo, detail FROM memory_audit ORDER BY id DESC LIMIT 30' });
    const live = Number((await this.rows({ sql: 'SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL' }))[0].n);
    const trashed = Number((await this.rows({ sql: 'SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL' }))[0].n);
    return { repos, trash, audit, live, trashed, retention_days: this.trashDays };
  }

  /** Move everything (except locked repositories and pinned entries, unless told otherwise) to the trash. */
  async wipeAll(o: { includeLocked?: boolean; includePinned?: boolean } = {}, actor: Actor = 'admin') {
    const batch = batchId('a');
    const lock = o.includeLocked ? '' : 'AND project NOT IN (SELECT repo FROM repos WHERE locked = 1)';
    const pin = o.includePinned ? '' : 'AND pinned = 0';
    const rs = await this.run(`UPDATE memories SET deleted_at = datetime('now'), delete_batch = ?, updated_at = datetime('now') WHERE deleted_at IS NULL ${lock} ${pin}`, [batch]);
    const n = affected(rs);
    await this.audit(actor, 'wipe_all', null, { entries: n, batch, include_locked: !!o.includeLocked, include_pinned: !!o.includePinned });
    return { wiped: n, batch };
  }

  /** Restore every entry of a removal batch, across repositories. */
  async restoreBatch(batch: string, actor: Actor = 'admin') {
    const n = affected(await this.run(`UPDATE memories SET deleted_at = NULL, delete_batch = NULL, updated_at = datetime('now') WHERE delete_batch = ? AND deleted_at IS NOT NULL`, [batch]));
    if (!n) throw new Error('nothing in the trash has that batch id');
    await this.run('INSERT OR IGNORE INTO repos(repo, display) SELECT DISTINCT project, project FROM memories');
    await this.audit(actor, 'restore_batch', null, { batch, restored: n });
    return { restored: n };
  }

  /** Permanently erase what is in the trash (all of it, or one repository's). This cannot be undone. */
  async emptyTrash(o: { repo?: string } = {}, actor: Actor = 'admin') {
    const key = o.repo ? normalizeRepo(o.repo).key : null;
    const n = await this.purge(key ? 'deleted_at IS NOT NULL AND project = ?' : 'deleted_at IS NOT NULL', key ? [key] : []);
    await this.audit(actor, 'empty_trash', key, { erased: n });
    return { erased: n };
  }

  /** Erase trash older than the retention period. Run at startup and daily. */
  async purgeExpiredTrash(): Promise<number> {
    const n = await this.purge(`deleted_at IS NOT NULL AND deleted_at <= datetime('now', ?)`, [`-${this.trashDays} days`]);
    if (n) await this.audit('system', 'purge_expired_trash', null, { erased: n });
    return n;
  }

  private async purge(cond: string, args: any[]): Promise<number> {
    const n = Number((await this.rows({ sql: `SELECT COUNT(*) AS n FROM memories WHERE ${cond}`, args }))[0].n);
    if (!n) return 0;
    // Entries that superseded an erased one keep existing; just drop the dangling link.
    await this.run(`UPDATE memories SET supersedes = NULL WHERE supersedes IN (SELECT id FROM memories WHERE ${cond})`, args);
    await this.run(`DELETE FROM memories WHERE ${cond}`, args); // the FTS delete trigger clears the search index
    await this.run(`DELETE FROM repos WHERE repo <> '${GENERAL}' AND locked = 0 AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.project = repos.repo)`);
    return n;
  }

  async exportJsonl(): Promise<string> {
    // Removed entries are not exported: a backup should not resurrect them.
    const rows = await this.rows({ sql: 'SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY id' });
    return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export const MEMORY_INSTRUCTIONS =
  'Persistent memory is organised per GitHub repository (owner/name); "general" is only for work that belongs to no repository. Workflow: ' +
  '(1) work out which repository the request is about (ask the user if it is unclear; never guess an owner); ' +
  '(2) call memory_start with it FIRST: it shows what was done there before, unfinished work and pinned notes, or suggests similar names if the repository is new; ' +
  '(3) before the work call memory_save with the repository, the user\'s request as "prompt" and your approach as "plan"; ' +
  '(4) after the work call memory_update with the "result" (what actually happened, incl. failures) and a status. ' +
  'memory_repos lists repositories that have memory; memory_search / memory_timeline dig deeper; memory_get returns full entries. Never store secrets. ' +
  'Removal happens only when the user asks: memory_forget removes one entry (restorable from the trash); memory_wipe_repo empties one repository in two steps and needs the user\'s explicit confirmation of the preview. ' +
  'There is deliberately no tool to wipe all memory: the user does that from the server\'s admin page.';

export function buildMemoryTools(store: MemoryStore): Tool[] {
  const repo = { type: 'string', description: 'Repository as "owner/name" (case-insensitive; a github.com URL also works), or "general" when no repository applies.' };
  return [
    {
      name: 'memory_start',
      description: 'CALL THIS FIRST when starting work on a repository. Shows what was done in that repository before (entry counts, unfinished work, pinned notes, recent entries). For a repository with no memory yet it lists similarly named ones so a typo does not open a second scope.',
      inputSchema: { type: 'object', properties: { repo }, required: ['repo'] },
      handler: (a) => store.start(a),
    },
    {
      name: 'memory_repos',
      description: 'List the repositories that have memory, with entry counts, unfinished counts and lock state. Optional query filters by name.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      handler: (a) => store.repos(a),
    },
    {
      name: 'memory_save',
      description: 'Save a new entry in a repository BEFORE doing the work: the user\'s request (prompt) and your plan. Status starts as "planned". Returns an id; later call memory_update with the result. A repository with no memory yet is created, unless a similarly named one exists (then confirm_new_repo is required).',
      inputSchema: {
        type: 'object',
        properties: {
          repo,
          title: { type: 'string', description: 'One-line summary (auto-derived from prompt if omitted).' },
          prompt: { type: 'string', description: "The user's request, trimmed to what matters." },
          plan: { type: 'string', description: 'Your plan / approach for this request.' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean', description: 'Pin important entries so they are always shown first.' },
          supersedes: { type: 'integer', description: 'Id of an older entry this one replaces.' },
          confirm_new_repo: { type: 'boolean', description: 'Only after memory_start/the error showed similar names and this really is a new repository.' },
        },
        required: ['repo', 'prompt'],
      },
      handler: (a) => store.save(a),
    },
    {
      name: 'memory_update',
      description: 'Add the RESULT to an existing entry after the work (what happened, what failed) and set its status. Can also edit plan/title/tags/pinned. Pass repo to make sure the id belongs to the repository you are working in.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          repo,
          result: { type: 'string', description: 'Replaces the stored result (max 8,000 chars).' },
          append_result: { type: 'string', description: 'Adds to the stored result on a new line instead of replacing it. Does not change the status.' },
          status: { type: 'string', enum: [...STATUSES], description: 'Defaults to "done" when a result is given.' },
          plan: { type: 'string' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean' },
        },
        required: ['id'],
      },
      handler: (a) => store.update(a),
    },
    {
      name: 'memory_search',
      description: 'Full-text search over past entries (one repository if repo is given, otherwise all). Returns compact rows (id, repo, title, status, snippet). Use memory_get for full text.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, repo, status: { type: 'string', enum: [...STATUSES] }, limit: { type: 'integer', description: 'Default 10, max 30.' } },
        required: ['query'],
      },
      handler: (a) => store.search(a),
    },
    {
      name: 'memory_timeline',
      description: 'Most recent entries (newest first) plus pinned ones, for one repository or all. Page back with before_id.',
      inputSchema: {
        type: 'object',
        properties: { repo, status: { type: 'string', enum: [...STATUSES] }, limit: { type: 'integer', description: 'Default 15, max 50.' }, before_id: { type: 'integer' } },
      },
      handler: (a) => store.timeline(a),
    },
    {
      name: 'memory_get',
      description: 'Get full entries (prompt, plan, result) by id. Pass id or ids (max 10).',
      inputSchema: { type: 'object', properties: { id: { type: 'integer' }, ids: { type: 'array', items: { type: 'integer' } } } },
      handler: (a) => store.get(a),
    },
    {
      name: 'memory_forget',
      description: 'Remove ONE entry of a repository. It moves to the trash and can be restored. Pinned entries must be unpinned first. Only when the user asks.',
      inputSchema: { type: 'object', properties: { repo, id: { type: 'integer' } }, required: ['repo', 'id'] },
      handler: (a) => store.forget(a),
    },
    {
      name: 'memory_wipe_repo',
      description:
        'Remove ALL entries of ONE repository (to the trash). Two steps. Step 1: call with repo only; nothing changes and you get a preview, a confirm_token and a confirm_phrase. Step 2: show the preview to the user, and ONLY if the user explicitly confirms, call again with repo, confirm_token and confirm_phrase. Never confirm on your own initiative. Pinned entries are skipped unless include_pinned: true (set at step 1). Locked repositories are refused.',
      inputSchema: {
        type: 'object',
        properties: {
          repo,
          include_pinned: { type: 'boolean', description: 'Also wipe pinned entries. Set in step 1.' },
          confirm_token: { type: 'string', description: 'From the step 1 preview.' },
          confirm_phrase: { type: 'string', description: 'The exact phrase from the step 1 preview.' },
        },
        required: ['repo'],
      },
      handler: (a) => store.wipeRepo(a),
    },
    {
      name: 'memory_trash',
      description: 'See what was removed and can still be restored (grouped by removal batch), optionally for one repository.',
      inputSchema: { type: 'object', properties: { repo } },
      handler: (a) => store.trash(a),
    },
    {
      name: 'memory_restore',
      description: 'Bring entries back from the trash: one entry by id, or everything removed together by batch (ids and batches come from memory_trash or the removal result).',
      inputSchema: { type: 'object', properties: { repo, id: { type: 'integer' }, batch: { type: 'string' } }, required: ['repo'] },
      handler: (a) => store.restore(a),
    },
    {
      name: 'memory_lock_repo',
      description: 'Protect a repository against wipes and renames. Only the user can unlock it again (admin page). Safe to use whenever the user wants a repository protected.',
      inputSchema: { type: 'object', properties: { repo }, required: ['repo'] },
      handler: (a) => store.lockRepo(a),
    },
    {
      name: 'memory_rename_repo',
      description: 'Fix a repository saved under a wrong name (typo) or renamed on GitHub: moves all its entries to the new name. Refuses if the new name already has memory (no automatic merging) or the repository is locked.',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      handler: (a) => store.renameRepo(a),
    },
  ];
}
