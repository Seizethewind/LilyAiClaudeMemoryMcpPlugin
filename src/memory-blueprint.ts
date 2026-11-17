/**
 * The Blueprint: one living, versioned document per repository (six sections, optimistic concurrency via
 * base_version, ten snapshots kept per section). Moved out of the MemoryStore class as is; it reaches the
 * store's database helpers through a small host interface instead of through `this`.
 */
import { GENERAL, normalizeRepo } from './memory-repos';
import { clean, clampInt, affected } from './memory-util';
import { redact } from './redact';
import {
  BLUEPRINT_SECTIONS, SECTION_GUIDE, MAX_SECTION, MAX_REVISIONS,
  type Actor, type DbResult, type BlueprintSection,
} from './memory-model';

export interface BlueprintHost {
  rows(stmt: { sql: string; args?: any[] }): Promise<Record<string, any>[]>;
  run(sql: string, args?: any[]): Promise<DbResult>;
  audit(actor: Actor, action: string, repo: string | null, detail?: Record<string, unknown>): Promise<void>;
  repoRow(key: string): Promise<any>;
  similar(key: string): Promise<{ repo: string; why: string }[]>;
  resolveRepoForWrite(a: any, tool: string): Promise<any>;
  touchRepo(key: string): Promise<void>;
}

export class BlueprintOps {
  constructor(private host: BlueprintHost) {}

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
  async blueprintBrief(key: string) {
    const bp = (await this.host.rows({ sql: 'SELECT version, based_on, updated_at FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) {
      return { exists: false, next: 'No blueprint yet. Once you understand how this repository is built, create one with blueprint_save.' };
    }
    const secs = await this.host.rows({ sql: 'SELECT section, length(content) AS chars FROM blueprint_sections WHERE repo = ?', args: [key] });
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
    const bp = (await this.host.rows({ sql: 'SELECT version, based_on, created_at, updated_at FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) {
      const repo = await this.host.repoRow(key);
      return {
        repo: repo?.display ?? display,
        exists: false,
        similar: repo ? [] : await this.host.similar(key),
        section_guide: SECTION_GUIDE,
        next: 'No blueprint yet. Create one with blueprint_save (sections, based_on = the commit you examined).',
      };
    }
    const want: BlueprintSection[] =
      a.sections === undefined || a.sections === null
        ? []
        : (Array.isArray(a.sections) ? a.sections : [a.sections]).flatMap((x: unknown) => (String(x).toLowerCase() === 'all' ? [...BLUEPRINT_SECTIONS] : [this.sectionName(x)]));
    const secs = await this.host.rows({ sql: 'SELECT section, content, version, updated_at FROM blueprint_sections WHERE repo = ?', args: [key] });
    const by = new Map(secs.map((r) => [String(r.section), r]));
    const outline = BLUEPRINT_SECTIONS.filter((x) => by.has(x)).map((x) => {
      const r = by.get(x)!;
      return { section: x, chars: String(r.content).length, version: Number(r.version), updated_at: r.updated_at, preview: String(r.content).replace(/\s+/g, ' ').slice(0, 200) };
    });
    const repo = await this.host.repoRow(key);
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

    const cur = (await this.host.rows({ sql: 'SELECT version, based_on FROM blueprints WHERE repo = ?', args: [key] }))[0];
    const curVersion = Number(cur?.version ?? 0);
    if (a.base_version !== undefined && a.base_version !== null && Number(a.base_version) !== curVersion) {
      throw new Error(
        `The blueprint changed since you read it: you passed base_version ${a.base_version}, the current version is ${curVersion}. ` +
          `Call blueprint_get for the current text, merge your changes into it, and save again with base_version ${curVersion}.`
      );
    }
    const existing = new Map(
      (await this.host.rows({ sql: 'SELECT section, content FROM blueprint_sections WHERE repo = ?', args: [key] })).map((r) => [String(r.section), String(r.content)])
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

    await this.host.resolveRepoForWrite(a, 'blueprint_save'); // creates the repository on first use, refusing look-alike names
    await this.host.run('INSERT OR IGNORE INTO blueprints(repo, version) VALUES (?, 0)', [key]);
    // Claim the next version atomically: of two concurrent saves, only one wins.
    const claimed = await this.host.run(
      `UPDATE blueprints SET version = version + 1, based_on = COALESCE(?, based_on), updated_at = datetime('now') WHERE repo = ? AND version = ?`,
      [basedOn, key, curVersion]
    );
    if (!affected(claimed)) throw new Error('The blueprint was changed by someone else a moment ago. Call blueprint_get, merge, and save again.');
    const version = curVersion + 1;
    for (const [name, text] of next) {
      await this.host.run(
        `INSERT INTO blueprint_sections(repo, section, content, version) VALUES (?,?,?,?)
         ON CONFLICT(repo, section) DO UPDATE SET content = excluded.content, version = excluded.version, updated_at = datetime('now')`,
        [key, name, text, version]
      );
      await this.host.run('INSERT INTO blueprint_revisions(repo, section, version, content, based_on, note) VALUES (?,?,?,?,?,?)', [key, name, version, text, basedOn, note]);
      await this.host.run(
        `DELETE FROM blueprint_revisions WHERE repo = ? AND section = ? AND id NOT IN
           (SELECT id FROM blueprint_revisions WHERE repo = ? AND section = ? ORDER BY id DESC LIMIT ${MAX_REVISIONS})`,
        [key, name, key, name]
      );
    }
    await this.host.touchRepo(key);
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
    const bp = (await this.host.rows({ sql: 'SELECT version FROM blueprints WHERE repo = ?', args: [key] }))[0];
    if (!bp) return { repo: display, exists: false, revisions: [] };
    const rows = await this.host.rows({
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
    const repo = await this.host.repoRow(key);
    if (repo?.locked) throw new Error(`${repo.display} is locked. Unlock it first.`);
    if (!(await this.host.rows({ sql: 'SELECT 1 AS x FROM blueprints WHERE repo = ?', args: [key] })).length) throw new Error(`${key} has no blueprint`);
    for (const table of ['blueprint_revisions', 'blueprint_sections', 'blueprints']) await this.host.run(`DELETE FROM ${table} WHERE repo = ?`, [key]);
    await this.host.audit(actor, 'delete_blueprint', key);
    return { repo: key, deleted: true };
  }

  // ---- admin level (never exposed as an MCP tool) --------------------------
}
