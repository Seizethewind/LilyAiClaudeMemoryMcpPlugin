/**
 * Persistent memory for Claude: one entry per request = prompt + plan + result.
 *
 * Flow: memory_save (prompt + plan, status "planned") -> do the work ->
 * memory_update (result + status). Search is progressive: memory_search and
 * memory_timeline return compact rows; memory_get returns the full entry.
 */

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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const COMPACT_COLS = `m.id, m.project, m.title, m.status, m.pinned, m.created_at, m.updated_at,
  substr(COALESCE(m.result, m.plan, m.prompt), 1, 160) AS snippet,
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

export class MemoryStore {
  ftsEnabled = false;
  constructor(private db: Db) {}

  private async rows(stmt: { sql: string; args?: any[] }): Promise<Record<string, any>[]> {
    const rs = await this.db.execute(stmt);
    return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
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
  }

  async save(a: any) {
    const prompt = clean(a.prompt, MAX_FIELD);
    if (!prompt.text) throw new Error('prompt is required');
    const plan = clean(a.plan, MAX_FIELD);
    const titleSrc = a.title ?? prompt.text.replace(/\s+/g, ' ').slice(0, 80);
    const title = clean(titleSrc, MAX_TITLE);
    const project = (clean(a.project, 80).text ?? 'general').toLowerCase();
    let supersedes: number | null = null;
    if (a.supersedes !== undefined && a.supersedes !== null) {
      supersedes = clampInt(a.supersedes, 0, 1, Number.MAX_SAFE_INTEGER);
      const exists = await this.rows({ sql: 'SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL', args: [supersedes] });
      if (!exists.length) throw new Error(`supersedes: memory ${supersedes} not found`);
    }
    const rs = await this.db.execute({
      sql: `INSERT INTO memories (project,title,prompt,plan,tags,pinned,supersedes) VALUES (?,?,?,?,?,?,?)`,
      args: [project, title.text, prompt.text, plan.text, toTags(a.tags), a.pinned ? 1 : 0, supersedes],
    });
    return {
      id: Number(rs.lastInsertRowid),
      status: 'planned',
      redactions: prompt.redactions + plan.redactions + title.redactions,
      next: 'When the work is done, call memory_update with this id, the result, and a status (done/partial/failed).',
    };
  }

  async update(a: any) {
    const id = clampInt(a.id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new Error('id is required');
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
    const rs = await this.db.execute({ sql: `UPDATE memories SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, args });
    const changed = (rs as any).rowsAffected ?? 1;
    if (!changed) throw new Error(`memory ${id} not found`);
    return { id, updated: true, status: status ?? 'unchanged', redactions };
  }

  async search(a: any) {
    const q = String(a.query ?? '').trim();
    if (!q) throw new Error('query is required');
    const limit = clampInt(a.limit, 10, 1, 30);
    const tokens = q.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (!tokens.length) return { count: 0, results: [] };
    const filters: string[] = ['m.deleted_at IS NULL'];
    const fargs: any[] = [];
    if (a.project) { filters.push('m.project = ?'); fargs.push(String(a.project).toLowerCase()); }
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
    const filters: string[] = ['m.deleted_at IS NULL'];
    const args: any[] = [];
    if (a.project) { filters.push('m.project = ?'); args.push(String(a.project).toLowerCase()); }
    if (a.status) { filters.push('m.status = ?'); args.push(String(a.status)); }
    if (a.before_id) { filters.push('m.id < ?'); args.push(clampInt(a.before_id, 0, 1, Number.MAX_SAFE_INTEGER)); }
    const results = await this.rows({
      sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE ${filters.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      args: [...args, limit],
    });
    const pinned = a.before_id ? [] : await this.rows({
      sql: `SELECT ${COMPACT_COLS} FROM memories m WHERE m.deleted_at IS NULL AND m.pinned = 1 ${a.project ? 'AND m.project = ?' : ''} ORDER BY m.id DESC LIMIT 10`,
      args: a.project ? [String(a.project).toLowerCase()] : [],
    });
    return { pinned, count: results.length, results, next_before_id: results.length === limit ? results[results.length - 1].id : null };
  }

  async get(a: any) {
    const ids: number[] = (Array.isArray(a.ids) ? a.ids : [a.id ?? a.ids]).map((x: unknown) => clampInt(x, 0, 1, Number.MAX_SAFE_INTEGER)).filter(Boolean).slice(0, 10);
    if (!ids.length) throw new Error('id or ids is required');
    const rows = await this.rows({
      sql: `SELECT m.*, (SELECT s.id FROM memories s WHERE s.supersedes = m.id AND s.deleted_at IS NULL LIMIT 1) AS superseded_by
            FROM memories m WHERE m.id IN (${ids.map(() => '?').join(',')}) AND m.deleted_at IS NULL ORDER BY m.id`,
      args: ids,
    });
    return { count: rows.length, memories: rows };
  }

  async forget(a: any) {
    const id = clampInt(a.id, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) throw new Error('id is required');
    if (a.hard === true) {
      // Erase the row (the FTS delete trigger removes it from the index). Entries
      // that superseded it keep existing; just drop the dangling link.
      await this.db.execute({ sql: 'UPDATE memories SET supersedes = NULL WHERE supersedes = ?', args: [id] });
      const rs = await this.db.execute({ sql: 'DELETE FROM memories WHERE id = ?', args: [id] });
      if (!((rs as any).rowsAffected ?? 1)) throw new Error(`memory ${id} not found`);
      return {
        id,
        deleted: 'hard (erased from the database and excluded from future backups)',
        note: 'Backups already written to GitHub still contain it in the repo history until that history is purged.',
      };
    }
    const rs = await this.db.execute({ sql: `UPDATE memories SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`, args: [id] });
    if (!((rs as any).rowsAffected ?? 1)) throw new Error(`memory ${id} not found`);
    return { id, deleted: 'soft (hidden from search and left out of future backups; pass hard:true to erase the row)' };
  }

  async exportJsonl(): Promise<string> {
    // Forgotten entries are not exported: a backup should not resurrect them.
    const rows = await this.rows({ sql: 'SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY id' });
    return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export const MEMORY_INSTRUCTIONS =
  'Persistent memory is available. Workflow for every request: (1) at the start of new work call memory_search (or memory_timeline) to recall relevant past entries; ' +
  '(2) before doing the work call memory_save with the user\'s request as "prompt" and your approach as "plan"; ' +
  '(3) after the work call memory_update with the "result" (what actually happened, incl. failures) and a status. ' +
  'Use memory_get only for entries you need in full. Never store secrets.';

export function buildMemoryTools(store: MemoryStore): Tool[] {
  const project = { type: 'string', description: 'Project tag, e.g. "lilyai". Defaults to "general".' };
  return [
    {
      name: 'memory_save',
      description: 'Save a new memory entry BEFORE doing the work: the user\'s request (prompt) and your plan. Status starts as "planned". Returns an id; later call memory_update with the result.',
      inputSchema: {
        type: 'object',
        properties: {
          project,
          title: { type: 'string', description: 'One-line summary (auto-derived from prompt if omitted).' },
          prompt: { type: 'string', description: "The user's request, trimmed to what matters." },
          plan: { type: 'string', description: 'Your plan / approach for this request.' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean', description: 'Pin important entries so timeline always shows them.' },
          supersedes: { type: 'integer', description: 'Id of an older entry this one replaces.' },
        },
        required: ['prompt'],
      },
      handler: (a) => store.save(a),
    },
    {
      name: 'memory_update',
      description: 'Add the RESULT to an existing entry after the work (what happened, what failed) and set its status. Can also edit plan/title/tags/pinned.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
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
      description: 'Full-text search over past entries. Returns compact rows (id, title, status, snippet). Use memory_get for full text.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, project, status: { type: 'string', enum: [...STATUSES] }, limit: { type: 'integer', description: 'Default 10, max 30.' } },
        required: ['query'],
      },
      handler: (a) => store.search(a),
    },
    {
      name: 'memory_timeline',
      description: 'Most recent entries (newest first) plus pinned ones. Page back with before_id.',
      inputSchema: {
        type: 'object',
        properties: { project, status: { type: 'string', enum: [...STATUSES] }, limit: { type: 'integer', description: 'Default 15, max 50.' }, before_id: { type: 'integer' } },
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
      description: 'Forget an entry. Default is a soft delete (hidden from search and left out of future backups); pass hard:true to erase the row. Only when the user asks.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' }, hard: { type: 'boolean', description: 'Erase the row instead of hiding it.' } },
        required: ['id'],
      },
      handler: (a) => store.forget(a),
    },
  ];
}
