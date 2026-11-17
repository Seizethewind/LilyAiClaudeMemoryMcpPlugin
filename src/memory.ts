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
import { redact } from './redact';
import { BlueprintOps } from './memory-blueprint';
import { clean, toTags, clampInt, affected, sameText, batchId } from './memory-util';
import { SCHEMA_SQL, FTS_SQL, V2_SQL, V3_SQL } from './memory-schema';
import { GENERAL, isRepoKey, normalizeRepo, similarRepos } from './memory-repos';
import {
  STATUSES, MAX_FIELD, MAX_TITLE, CONFIRM_MINUTES, MAX_SECTION, MAX_REVISIONS, BLUEPRINT_SECTIONS, SECTION_GUIDE,
  type Db, type DbResult, type Status, type Actor, type RepoSummary, type BlueprintSection,
} from './memory-model';

// Public surface stays here, so other modules keep importing from './memory'.
export { redact } from './redact';
export { GENERAL, isRepoKey, normalizeRepo, similarRepos } from './memory-repos';
export { BLUEPRINT_SECTIONS, SECTION_GUIDE } from './memory-model';
export type { Db, DbResult, Tool, Actor, RepoSummary, BlueprintSection } from './memory-model';
export { MEMORY_INSTRUCTIONS, buildMemoryTools } from './memory-tools';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const COMPACT_COLS = `m.id, m.project AS repo, m.title, m.status, m.pinned, m.created_at, m.updated_at,
  substr(COALESCE(m.result, m.plan, m.prompt), 1, 160) AS snippet,
  (SELECT s.id FROM memories s WHERE s.supersedes = m.id AND s.deleted_at IS NULL LIMIT 1) AS superseded_by`;

const FULL_COLS = `m.id, m.project AS repo, m.title, m.prompt, m.plan, m.result, m.status, m.tags, m.pinned,
  m.supersedes, m.created_at, m.updated_at,
  (SELECT s.id FROM memories s WHERE s.supersedes = m.id AND s.deleted_at IS NULL LIMIT 1) AS superseded_by`;


export class MemoryStore {
  ftsEnabled = false;
  /** How long removed entries stay restorable in the trash before they are erased for good. */
  trashDays: number;

  private blueprints: BlueprintOps;

  constructor(private db: Db, opts: { trashDays?: number } = {}) {
    this.trashDays = Math.max(1, Math.trunc(opts.trashDays ?? 30));
    this.blueprints = new BlueprintOps({
      rows: (stmt) => this.rows(stmt),
      run: (sql, args) => this.run(sql, args),
      audit: (actor, action, repo, detail) => this.audit(actor, action, repo, detail),
      repoRow: (key) => this.repoRow(key),
      similar: (key) => this.similar(key),
      resolveRepoForWrite: (a, tool) => this.resolveRepoForWrite(a, tool),
      touchRepo: (key) => this.touchRepo(key),
    });
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
      blueprint: await this.blueprints.blueprintBrief(key),
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


  // ---- Blueprint (implemented in memory-blueprint.ts) ---------------------

  getBlueprint(a: any) {
    return this.blueprints.getBlueprint(a);
  }
  saveBlueprint(a: any) {
    return this.blueprints.saveBlueprint(a);
  }
  blueprintHistory(a: any) {
    return this.blueprints.blueprintHistory(a);
  }
  deleteBlueprint(key: string, actor: Actor = 'admin') {
    return this.blueprints.deleteBlueprint(key, actor);
  }

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

