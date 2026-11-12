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

// Schema v3: one living Blueprint per repository (see the Blueprint section below).
const V3_SQL = [
  `CREATE TABLE IF NOT EXISTS blueprints (
     repo       TEXT PRIMARY KEY,
     version    INTEGER NOT NULL DEFAULT 0,
     based_on   TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS blueprint_sections (
     repo       TEXT NOT NULL,
     section    TEXT NOT NULL,
     content    TEXT NOT NULL,
     version    INTEGER NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (repo, section)
   )`,
  `CREATE TABLE IF NOT EXISTS blueprint_revisions (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     repo     TEXT NOT NULL,
     section  TEXT NOT NULL,
     version  INTEGER NOT NULL,
     content  TEXT NOT NULL,
     based_on TEXT,
     note     TEXT,
     at       TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_blueprint_rev ON blueprint_revisions(repo, section, id)`,
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
  /** Blueprint version, or null when the repository has no blueprint yet. */
  blueprint: number | null;
}

/**
 * A Blueprint is the one living document per repository: how it is made, why,
 * what the tests said, and what to improve next. Memory entries record each
 * request; the Blueprint records the repository itself and is updated in place.
 */
export const BLUEPRINT_SECTIONS = ['overview', 'architecture', 'implementation', 'logic', 'tests', 'improvements'] as const;
export type BlueprintSection = (typeof BLUEPRINT_SECTIONS)[number];
export const SECTION_GUIDE: Record<BlueprintSection, string> = {
  overview: 'What the repository is and who it is for; stack and runtime in a few lines; current state (working / in progress / broken).',
  architecture:
    'How it is made: folder and module structure, components and how they connect, data flow and data model, external services, and how to install, build, run and deploy it.',
  implementation:
    'Detailed implementation: what each important file or module does and how, key functions, algorithms, protocols and the edge cases they handle, configuration and environment variables. Concrete enough to change it safely.',
  logic:
    'Why it is built this way: design decisions and their reasoning, trade-offs, alternatives rejected, invariants and security assumptions. Only reasons you know (from the code, docs or the user), never invented ones.',
  tests:
    'Test strategy and results: how to run the tests; the latest results with date, commit and exact command (pass/fail counts, failures); what was verified by actually running it and what was NOT verified; known gaps.',
  improvements:
    'Better improvements, ranked: what to change next and why, expected benefit and effort; known bugs, risks and tech debt. Remove an item once done and note it under tests or implementation.',
};
const MAX_SECTION = 20000;
const MAX_REVISIONS = 10; // snapshots kept per section

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

  private async migrate(): Promise<void> {
    const v = await this.rows({ sql: 'SELECT MAX(version) AS v FROM schema_versions' });
    const current = Number(v[0]?.v ?? 0);
    if (current < 2) await this.migrateV2();
    if (current < 3) await this.migrateV3();
  }

  /** v3: blueprints. Purely additive. */
  private async migrateV3(): Promise<void> {
    for (const sql of V3_SQL) await this.run(sql);
    await this.run('INSERT OR IGNORE INTO schema_versions(version) VALUES (3)');
  }

  /** v2: entries become repository-scoped. Legacy "project" labels are folded into "general" (kept as a tag). */
  private async migrateV2(): Promise<void> {
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

  /**
   * Opens a repository on first write. Repositories cannot have look-alike names:
   * a typo must not silently open a second scope, so a new name that resembles an
   * existing one is refused until the caller confirms it really is new.
   */
  private async resolveRepoForWrite(a: any, tool: string) {
    const { key, display } = normalizeRepo(a.repo);
    const existing = await this.repoRow(key);
    if (!existing) {
      const similar = await this.similar(key);
      if (similar.length && a.confirm_new_repo !== true) {
        throw new Error(
          `"${display}" has no memory yet, but similar repositories do: ${similar.map((s) => `${s.repo} (${s.why})`).join('; ')}. ` +
            `If you meant one of them, use its exact name. If this really is a new repository, call ${tool} again with confirm_new_repo: true.`
        );
      }
      await this.run('INSERT OR IGNORE INTO repos(repo, display) VALUES (?, ?)', [key, display]);
    }
    return existing;
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
      blueprint: await this.blueprintBrief(key),
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
    const existing = await this.resolveRepoForWrite(a, 'memory_save');
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
    const out: Record<string, unknown> = { id, repo: cur[0].project, updated: true, status: status ?? 'unchanged', redactions };
    if (cur[0].project !== GENERAL && (status === 'done' || status === 'partial' || status === 'failed')) {
      const hasBlueprint = (await this.rows({ sql: 'SELECT 1 AS x FROM blueprints WHERE repo = ?', args: [cur[0].project] })).length > 0;
      out.blueprint_reminder = hasBlueprint
        ? 'If this work changed how the repository is built, why, how it is tested, or what to improve next, update the affected blueprint sections (blueprint_save).'
        : 'This repository has no blueprint yet. Create one with blueprint_save (blueprint_get lists what each section should hold).';
    }
    return out;
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
              (SELECT COUNT(*) FROM memories m WHERE m.project = r.repo AND m.deleted_at IS NOT NULL) AS in_trash,
              (SELECT b.version FROM blueprints b WHERE b.repo = r.repo) AS blueprint
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
      blueprint: r.blueprint === null || r.blueprint === undefined ? null : Number(r.blueprint),
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
    for (const table of ['blueprints', 'blueprint_sections', 'blueprint_revisions']) {
      await this.run(`UPDATE ${table} SET repo = ? WHERE repo = ?`, [to.key, from.key]);
    }
    await this.run('DELETE FROM repos WHERE repo = ?', [from.key]);
    await this.audit(actor, 'rename', from.key, { to: to.key });
    return { from: from.key, to: to.key, renamed: true };
  }

  // ---- blueprint: one living document per repository -------------------------

  private blueprintRepo(input: unknown) {
    const n = normalizeRepo(input);
    if (n.key === GENERAL) throw new Error('A blueprint describes a repository ("owner/name"); "general" has none.');
    return n;
  }

  private sectionName(v: unknown): BlueprintSection {
    const name = String(v ?? '').trim().toLowerCase();
    if (!(BLUEPRINT_SECTIONS as readonly string[]).includes(name)) throw new Error(`unknown section "${String(v).slice(0, 40)}". Sections: ${BLUEPRINT_SECTIONS.join(', ')}.`);
    return name as BlueprintSection;
  }

  private sectionMap(v: unknown, param: string): Partial<Record<BlueprintSection, string>> {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${param} must be an object like { "tests": "..." }`);
    const out: Partial<Record<BlueprintSection, string>> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const name = this.sectionName(k);
      if (typeof val !== 'string' || !val.trim()) throw new Error(`${param}.${name} must be a non-empty string`);
      out[name] = val;
    }
    return out;
  }

  /** Short summary used by memory_start: does this repository have a blueprint, and what is in it? */
  private async blueprintBrief(key: string) {
    const bp = (await this.rows({ sql: 'SELECT version, based_on, updated_at FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) {
      return { exists: false, next: 'No blueprint yet. Once you understand how this repository is built, create one with blueprint_save.' };
    }
    const secs = await this.rows({ sql: 'SELECT section, length(content) AS chars FROM blueprint_sections WHERE repo = ?', args: [key] });
    const present = secs.map((r) => String(r.section));
    return {
      exists: true,
      version: Number(bp.version),
      based_on: bp.based_on ?? null,
      updated_at: bp.updated_at,
      sections: BLUEPRINT_SECTIONS.filter((x) => present.includes(x)).map((x) => ({ section: x, chars: Number(secs.find((r) => r.section === x)!.chars) })),
      missing: BLUEPRINT_SECTIONS.filter((x) => !present.includes(x)),
      next: 'Read it with blueprint_get (outline first, then the sections you need) before working.',
    };
  }

  /** Outline by default (cheap); pass sections to read their full text ("all" for everything). */
  async getBlueprint(a: any) {
    const { key, display } = this.blueprintRepo(a.repo);
    const bp = (await this.rows({ sql: 'SELECT version, based_on, created_at, updated_at FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) {
      const repo = await this.repoRow(key);
      return {
        repo: repo?.display ?? display,
        exists: false,
        similar: repo ? [] : await this.similar(key),
        section_guide: SECTION_GUIDE,
        next: 'No blueprint yet. Create one with blueprint_save (sections, based_on = the commit you examined).',
      };
    }
    const want: BlueprintSection[] =
      a.sections === undefined || a.sections === null
        ? []
        : (Array.isArray(a.sections) ? a.sections : [a.sections]).flatMap((x: unknown) => (String(x).toLowerCase() === 'all' ? [...BLUEPRINT_SECTIONS] : [this.sectionName(x)]));
    const secs = await this.rows({ sql: 'SELECT section, content, version, updated_at FROM blueprint_sections WHERE repo = ?', args: [key] });
    const by = new Map(secs.map((r) => [String(r.section), r]));
    const outline = BLUEPRINT_SECTIONS.filter((x) => by.has(x)).map((x) => {
      const r = by.get(x)!;
      return { section: x, chars: String(r.content).length, version: Number(r.version), updated_at: r.updated_at, preview: String(r.content).replace(/\s+/g, ' ').slice(0, 200) };
    });
    const repo = await this.repoRow(key);
    return {
      repo: repo?.display ?? display,
      exists: true,
      version: Number(bp.version),
      based_on: bp.based_on ?? null,
      created_at: bp.created_at,
      updated_at: bp.updated_at,
      outline,
      missing: BLUEPRINT_SECTIONS.filter((x) => !by.has(x)),
      content: want.length ? Object.fromEntries([...new Set(want)].map((x) => [x, by.get(x)?.content ?? null])) : undefined,
      next: want.length
        ? `When you save changes, pass base_version: ${Number(bp.version)} so a concurrent edit is detected.`
        : 'Outline only. Call blueprint_get again with sections (e.g. ["architecture","tests"], or ["all"]) for the full text.',
    };
  }

  /**
   * Create or update sections. `sections` replaces a section; `append` adds to it.
   * Every saved section is snapshotted so a bad edit can be recovered (blueprint_history).
   */
  async saveBlueprint(a: any) {
    const { key, display } = this.blueprintRepo(a.repo);
    const replace = this.sectionMap(a.sections, 'sections');
    const append = this.sectionMap(a.append, 'append');
    const both = Object.keys(replace).filter((k) => k in append);
    if (both.length) throw new Error(`section ${both.join(', ')} is in both sections (replace) and append; use one`);
    if (!Object.keys(replace).length && !Object.keys(append).length) {
      throw new Error('nothing to save: pass sections (replace a section) and/or append (add to a section)');
    }
    const basedOn = a.based_on === undefined || a.based_on === null ? null : clean(a.based_on, 80).text;
    const note = a.note === undefined || a.note === null ? null : clean(a.note, 200).text;

    const cur = (await this.rows({ sql: 'SELECT version, based_on FROM blueprints WHERE repo = ?', args: [key] }))[0];
    const curVersion = Number(cur?.version ?? 0);
    if (a.base_version !== undefined && a.base_version !== null && Number(a.base_version) !== curVersion) {
      throw new Error(
        `The blueprint changed since you read it: you passed base_version ${a.base_version}, the current version is ${curVersion}. ` +
          `Call blueprint_get for the current text, merge your changes into it, and save again with base_version ${curVersion}.`
      );
    }
    const existing = new Map(
      (await this.rows({ sql: 'SELECT section, content FROM blueprint_sections WHERE repo = ?', args: [key] })).map((r) => [String(r.section), String(r.content)])
    );

    let redactions = 0;
    const next = new Map<BlueprintSection, string>();
    for (const [name, raw] of [...Object.entries(replace), ...Object.entries(append)] as [BlueprintSection, string][]) {
      const r = redact(raw.trim());
      redactions += r.count;
      const prev = existing.get(name) ?? '';
      const text = name in append ? (prev ? `${prev}\n\n${r.text}` : r.text) : r.text;
      if (text.length > MAX_SECTION) {
        throw new Error(
          `section "${name}" would be ${text.length} characters; the limit is ${MAX_SECTION}. ` +
            (name in append ? 'Condense it and save it with sections (replace) instead of appending.' : 'Condense it.')
        );
      }
      if (text !== prev) next.set(name, text);
    }
    if (!next.size) return { repo: display, version: curVersion, unchanged: true, note: 'Nothing changed; the blueprint already says this.' };

    await this.resolveRepoForWrite(a, 'blueprint_save'); // creates the repository on first use, refusing look-alike names
    await this.run('INSERT OR IGNORE INTO blueprints(repo, version) VALUES (?, 0)', [key]);
    // Claim the next version atomically: of two concurrent saves, only one wins.
    const claimed = await this.run(
      `UPDATE blueprints SET version = version + 1, based_on = COALESCE(?, based_on), updated_at = datetime('now') WHERE repo = ? AND version = ?`,
      [basedOn, key, curVersion]
    );
    if (!affected(claimed)) throw new Error('The blueprint was changed by someone else a moment ago. Call blueprint_get, merge, and save again.');
    const version = curVersion + 1;
    for (const [name, text] of next) {
      await this.run(
        `INSERT INTO blueprint_sections(repo, section, content, version) VALUES (?,?,?,?)
         ON CONFLICT(repo, section) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = datetime('now')`,
        [key, name, text, version]
      );
      await this.run('INSERT INTO blueprint_revisions(repo, section, version, content, based_on, note) VALUES (?,?,?,?,?,?)', [key, name, version, text, basedOn, note]);
      await this.run(
        `DELETE FROM blueprint_revisions WHERE repo = ? AND section = ? AND id NOT IN
           (SELECT id FROM blueprint_revisions WHERE repo = ? AND section = ? ORDER BY id DESC LIMIT ${MAX_REVISIONS})`,
        [key, name, key, name]
      );
    }
    await this.touchRepo(key);
    const present = new Set([...existing.keys(), ...next.keys()]);
    return {
      repo: display,
      version,
      created: !cur,
      saved: BLUEPRINT_SECTIONS.filter((x) => next.has(x)),
      based_on: basedOn ?? cur?.based_on ?? null,
      redactions,
      missing: BLUEPRINT_SECTIONS.filter((x) => !present.has(x)),
    };
  }

  /** Earlier snapshots of a blueprint (newest first). To undo an edit, save an old snapshot's content again. */
  async blueprintHistory(a: any) {
    const { key, display } = this.blueprintRepo(a.repo);
    const section = a.section ? this.sectionName(a.section) : null;
    const limit = clampInt(a.limit, 10, 1, 30);
    const bp = (await this.rows({ sql: 'SELECT version FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) return { repo: display, exists: false, revisions: [] };
    const rows = await this.rows({
      sql: `SELECT version, section, based_on, note, at, length(content) AS chars${a.include_content ? ', content' : ''}
            FROM blueprint_revisions WHERE repo = ? ${section ? 'AND section = ?' : ''} ORDER BY id DESC LIMIT ?`,
      args: section ? [key, section, limit] : [key, limit],
    });
    return {
      repo: display,
      current_version: Number(bp.version),
      keeps: `the last ${MAX_REVISIONS} snapshots of each section`,
      count: rows.length,
      revisions: rows.map((r) => ({ ...r, version: Number(r.version), chars: Number(r.chars) })),
    };
  }

  /** Admin page only (no MCP tool): permanently deletes a repository's blueprint and its history. Refused for locked repositories. */
  async deleteBlueprint(key: string, actor: Actor = 'admin') {
    const repo = await this.repoRow(key);
    if (repo?.locked) throw new Error(`${repo.display} is locked. Unlock it first.`);
    if (!(await this.rows({ sql: 'SELECT 1 AS x FROM blueprints WHERE repo = ?', args: [key] })).length) throw new Error(`${key} has no blueprint`);
    for (const table of ['blueprint_revisions', 'blueprint_sections', 'blueprints']) await this.run(`DELETE FROM ${table} WHERE repo = ?`, [key]);
    await this.audit(actor, 'delete_blueprint', key);
    return { repo: key, deleted: true };
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
    await this.run(`DELETE FROM repos WHERE repo <> '${GENERAL}' AND locked = 0 AND NOT EXISTS (SELECT 1 FROM memories WHERE memories.project = repos.repo) AND NOT EXISTS (SELECT 1 FROM blueprints WHERE blueprints.repo = repos.repo)`);
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
  'Each repository also has one living Blueprint (blueprint_get / blueprint_save): how it is built, the reasoning behind it, test results and the best next improvements. ' +
  'memory_start reports whether it exists. Read it before working (outline first), and after meaningful work update the affected sections in place, passing based_on (commit) and base_version. ' +
  'Record only what you verified: never invent reasons or claim test results you did not run. Forgetting or wiping memory never touches the blueprint; only the user deletes one, from the admin page. ' +
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
    {
      name: 'blueprint_get',
      description:
        'Read the Blueprint of a repository: the living record of how it is built, the logic behind it, test results and next improvements. Default returns an outline (size, version, preview per section); pass sections (e.g. ["architecture","tests"] or ["all"]) for full text. Sections: ' +
        BLUEPRINT_SECTIONS.join(', ') + '. If none exists, returns what each section should contain.',
      inputSchema: {
        type: 'object',
        properties: { repo, sections: { type: 'array', items: { type: 'string', enum: [...BLUEPRINT_SECTIONS, 'all'] } } },
        required: ['repo'],
      },
      handler: (a) => store.getBlueprint(a),
    },
    {
      name: 'blueprint_save',
      description:
        'Create or update sections of a repository\'s Blueprint. "sections" replaces whole sections; "append" adds to them. Only write what you verified from the code, tests or the user; keep each section under ' + MAX_SECTION +
        ' characters. Pass based_on (the commit SHA you examined) and base_version (the version you read) so concurrent edits are detected. Earlier versions are kept (blueprint_history). ' +
        Object.entries(SECTION_GUIDE).map(([k, v]) => `${k}: ${v}`).join(' | '),
      inputSchema: {
        type: 'object',
        properties: {
          repo,
          sections: { type: 'object', description: 'Replace sections: { "tests": "text", ... }', additionalProperties: { type: 'string' } },
          append: { type: 'object', description: 'Append to sections: { "improvements": "text", ... }', additionalProperties: { type: 'string' } },
          based_on: { type: 'string', description: 'Commit SHA (or ref) this blueprint reflects.' },
          base_version: { type: 'integer', description: 'Version from blueprint_get; the save is refused if the blueprint changed since.' },
          note: { type: 'string', description: 'One line on what changed and why.' },
          confirm_new_repo: { type: 'boolean', description: 'Only when the repository is new and a similar name exists.' },
        },
        required: ['repo'],
      },
      handler: (a) => store.saveBlueprint(a),
    },
    {
      name: 'blueprint_history',
      description: 'Earlier snapshots of a Blueprint (last 10 per section). To undo an edit, read the old content (include_content: true) and save it again.',
      inputSchema: {
        type: 'object',
        properties: { repo, section: { type: 'string', enum: [...BLUEPRINT_SECTIONS] }, limit: { type: 'integer' }, include_content: { type: 'boolean' } },
        required: ['repo'],
      },
      handler: (a) => store.blueprintHistory(a),
    },
  ];
}
