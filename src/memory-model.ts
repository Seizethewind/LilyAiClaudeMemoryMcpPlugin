/** Shared types and limits of the memory store (rows, actors, Blueprint sections). */

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

export const STATUSES = ['planned', 'done', 'partial', 'failed'] as const;
export type Status = (typeof STATUSES)[number];
export const MAX_FIELD = 8000;
export const MAX_TITLE = 200;

export const CONFIRM_MINUTES = 10;

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
export const MAX_SECTION = 20000;
export const MAX_REVISIONS = 10; // snapshots kept per section
