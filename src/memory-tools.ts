/** The MCP memory and Blueprint tools, and the instructions that explain the workflow to the model. */
import type { MemoryStore } from './memory';
import { STATUSES, MAX_SECTION, BLUEPRINT_SECTIONS, SECTION_GUIDE, type Tool } from './memory-model';

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
