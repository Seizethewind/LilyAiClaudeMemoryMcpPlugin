import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, normalizeRepo } from '../src/memory';
import { sqliteDb } from './sqlite-db';

async function fresh(opts?: { trashDays?: number }) {
  const { db, raw } = sqliteDb();
  const store = new MemoryStore(db, opts);
  await store.init();
  return { store, raw };
}

const live = async (s: MemoryStore, repo: string) => (await s.timeline({ repo, limit: 50 })).results.length;

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

test('repository names are normalised: case, URLs, ssh remotes, "general"', () => {
  assert.deepEqual(normalizeRepo('Seizethewind/LilyAi'), { key: 'seizethewind/lilyai', display: 'Seizethewind/LilyAi' });
  assert.equal(normalizeRepo('https://github.com/Foo/Bar.git').key, 'foo/bar');
  assert.equal(normalizeRepo('https://github.com/foo/bar/tree/main/src?x=1#y').key, 'foo/bar');
  assert.equal(normalizeRepo('git@github.com:foo/bar.git').key, 'foo/bar');
  assert.equal(normalizeRepo('GENERAL').key, 'general');
  for (const bad of ['lilyai', 'a/b/c', 'foo/', '/bar', 'foo/..', 'has space/x', 'x'.repeat(50) + '/y']) {
    assert.throws(() => normalizeRepo(bad), /valid repository name/, bad);
  }
  assert.throws(() => normalizeRepo(''), /repo is required/);
});

test('every entry needs a repository; the same repository in another case is one scope', async () => {
  const { store } = await fresh();
  await assert.rejects(store.save({ prompt: 'x' }), /repo is required/);
  await assert.rejects(store.save({ repo: 'lilyai', prompt: 'x' }), /valid repository name/);
  const a = await store.save({ repo: 'Acme/Widget', prompt: 'first' });
  const b = await store.save({ repo: 'acme/WIDGET', prompt: 'second' });
  assert.equal(a.created_repo, true);
  assert.equal(b.created_repo, false);
  assert.equal(b.repo, 'Acme/Widget'); // keeps the spelling it was first saved with
  assert.equal((await store.repos({ query: 'widget' })).count, 1);
});

test('look-alike repository names are refused unless the caller confirms a new repository', async () => {
  const { store } = await fresh();
  await store.save({ repo: 'acme/widget', prompt: 'a' });
  await assert.rejects(store.save({ repo: 'acme/widgit', prompt: 'typo' }), /similar repositories.*acme\/widget/);
  await assert.rejects(store.save({ repo: 'other/widget', prompt: 'fork?' }), /same repository name under a different owner/);
  assert.equal((await store.save({ repo: 'acme/billing', prompt: 'unrelated' })).created_repo, true); // no false alarm
  const ok = await store.save({ repo: 'other/widget', prompt: 'a real fork', confirm_new_repo: true });
  assert.equal(ok.created_repo, true);
});

test('memory_start: unknown repository suggests similar names; known one shows history', async () => {
  const { store } = await fresh();
  const unknown: any = await store.start({ repo: 'acme/nothing-like-it' });
  assert.equal(unknown.known, false);
  assert.deepEqual(unknown.similar, []);

  const done = (await store.save({ repo: 'acme/widget', prompt: 'finished work' })).id;
  await store.update({ id: done, result: 'shipped' });
  const open = (await store.save({ repo: 'acme/widget', prompt: 'still open', title: 'Open task' })).id;
  const pin = (await store.save({ repo: 'acme/widget', prompt: 'remember this', pinned: true })).id;
  const typo: any = await store.start({ repo: 'acme/widgit' });
  assert.equal(typo.known, false);
  assert.equal(typo.similar[0].repo, 'acme/widget');

  const s: any = await store.start({ repo: 'ACME/Widget' });
  assert.equal(s.known, true);
  assert.equal(s.entries, 3);
  assert.deepEqual(s.by_status, { done: 1, planned: 2 });
  assert.deepEqual(s.unfinished.map((r: any) => r.id).sort(), [open, pin].sort());
  assert.deepEqual(s.pinned.map((r: any) => r.id), [pin]);
  assert.equal(s.locked, false);
});

test('search and timeline can be scoped to one repository; ids cannot be updated across repositories', async () => {
  const { store } = await fresh();
  const a = (await store.save({ repo: 'acme/alpha', prompt: 'shared keyword plus alpha detail', pinned: true })).id;
  const b = (await store.save({ repo: 'acme/bravo', prompt: 'shared keyword plus bravo detail', pinned: true })).id;
  const all: any = await store.search({ query: 'keyword' });
  assert.deepEqual(all.results.map((r: any) => r.repo).sort(), ['acme/alpha', 'acme/bravo']);
  assert.deepEqual((await store.search({ query: 'keyword', repo: 'ACME/bravo' })).results.map((r: any) => r.id), [b]);
  const tl: any = await store.timeline({ repo: 'acme/alpha' });
  assert.deepEqual(tl.results.map((r: any) => r.id), [a]);
  assert.deepEqual(tl.pinned.map((r: any) => r.id), [a]);
  await assert.rejects(store.update({ id: a, repo: 'acme/bravo', result: 'wrong repo' }), /belongs to acme\/alpha, not acme\/bravo/);
  assert.equal((await store.update({ id: a, repo: 'acme/alpha', result: 'right repo' })).repo, 'acme/alpha');
});

// ---------------------------------------------------------------------------
// Level 1: one entry
// ---------------------------------------------------------------------------

test('forget removes one entry of the named repository into the trash, and restore brings it back', async () => {
  const { store } = await fresh();
  const id = (await store.save({ repo: 'acme/widget', prompt: 'remove me please' })).id;
  const other = (await store.save({ repo: 'acme/billing', prompt: 'someone else', pinned: true })).id;

  await assert.rejects(store.forget({ repo: 'acme/billing', id }), /belongs to acme\/widget/);
  await assert.rejects(store.forget({ repo: 'acme/billing', id: other }), /pinned/);
  assert.equal(await live(store, 'acme/widget'), 1);

  const out: any = await store.forget({ repo: 'acme/widget', id });
  assert.equal(out.removed, true);
  assert.equal(await live(store, 'acme/widget'), 0);
  assert.equal((await store.search({ query: 'remove' })).count, 0);
  const trash: any = await store.trash({ repo: 'acme/widget' });
  assert.equal(trash.batches[0].entries, 1);
  assert.equal(trash.entries[0].id, id);
  assert.equal((await store.trash({ repo: 'acme/billing' }) as any).batches.length, 0);

  await assert.rejects(store.restore({ repo: 'acme/billing', id }), /nothing in the trash/);
  assert.equal((await store.restore({ repo: 'acme/widget', id })).restored, 1);
  assert.equal((await store.search({ query: 'remove' })).count, 1);
  await assert.rejects(store.restore({ repo: 'acme/widget', id }), /nothing in the trash/);
  await assert.rejects(store.restore({ repo: 'acme/widget' }), /pass id/);
});

// ---------------------------------------------------------------------------
// Level 2: one repository, behind a two-step confirmation
// ---------------------------------------------------------------------------

async function seedWidget(store: MemoryStore, n = 3, pinned = 1) {
  for (let i = 0; i < n; i++) await store.save({ repo: 'acme/widget', prompt: `note ${i}`, pinned: i < pinned });
}

test('wipe_repo: the preview changes nothing and the wrong phrase does not consume the token', async () => {
  const { store } = await fresh();
  await seedWidget(store);
  const p: any = await store.wipeRepo({ repo: 'acme/widget' });
  assert.equal(p.preview, true);
  assert.equal(p.entries, 2);
  assert.equal(p.pinned_skipped, 1);
  assert.equal(p.confirm_phrase, 'WIPE acme/widget 2');
  assert.match(p.instructions, /Never confirm on your own/);
  assert.equal(await live(store, 'acme/widget'), 3);

  await assert.rejects(store.wipeRepo({ repo: 'acme/widget', confirm_token: p.confirm_token, confirm_phrase: 'yes do it' }), /must be exactly: WIPE acme\/widget 2/);
  assert.equal(await live(store, 'acme/widget'), 3);
  const done: any = await store.wipeRepo({ repo: 'acme/widget', confirm_token: p.confirm_token, confirm_phrase: 'wipe  ACME/widget 2' });
  assert.equal(done.wiped, 2);
  assert.equal(await live(store, 'acme/widget'), 1); // the pinned one survived

  // single use
  await assert.rejects(store.wipeRepo({ repo: 'acme/widget', confirm_token: p.confirm_token, confirm_phrase: p.confirm_phrase }), /unknown, expired or already used/);
  // and the whole thing is undoable
  assert.equal((await store.restore({ repo: 'acme/widget', batch: done.batch })).restored, 2);
  assert.equal(await live(store, 'acme/widget'), 3);
});

test('wipe_repo: stale, expired and mismatched confirmations are refused', async () => {
  const { store, raw } = await fresh();
  await seedWidget(store, 3, 0);
  await store.save({ repo: 'acme/billing', prompt: 'other repo' });

  // the repository changed after the preview
  const p1: any = await store.wipeRepo({ repo: 'acme/widget' });
  await store.save({ repo: 'acme/widget', prompt: 'added after the preview' });
  await assert.rejects(store.wipeRepo({ repo: 'acme/widget', confirm_token: p1.confirm_token, confirm_phrase: p1.confirm_phrase }), /changed since the preview/);
  assert.equal(await live(store, 'acme/widget'), 4);

  // expired
  const p2: any = await store.wipeRepo({ repo: 'acme/widget' });
  raw.prepare(`UPDATE confirmations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token = ?`).run(p2.confirm_token);
  await assert.rejects(store.wipeRepo({ repo: 'acme/widget', confirm_token: p2.confirm_token, confirm_phrase: p2.confirm_phrase }), /expired/);

  // a token cannot be carried over to another repository
  const p3: any = await store.wipeRepo({ repo: 'acme/widget' });
  await assert.rejects(store.wipeRepo({ repo: 'acme/billing', confirm_token: p3.confirm_token, confirm_phrase: 'WIPE acme/billing 1' }), /different wipe request/);
  assert.equal(await live(store, 'acme/widget'), 4);
  assert.equal(await live(store, 'acme/billing'), 1);
});

test('wipe_repo: pinned entries need include_pinned at preview time; empty and unknown repositories are handled', async () => {
  const { store } = await fresh();
  await seedWidget(store, 3, 1);
  const p: any = await store.wipeRepo({ repo: 'acme/widget', include_pinned: true });
  assert.equal(p.entries, 3);
  // a token from a pinned-included preview cannot be used for a pinned-skipping wipe
  await assert.rejects(store.wipeRepo({ repo: 'acme/widget', confirm_token: p.confirm_token, confirm_phrase: 'WIPE acme/widget 2' }), /different wipe request|must be exactly/);
  const done: any = await store.wipeRepo({ repo: 'acme/widget', include_pinned: true, confirm_token: p.confirm_token, confirm_phrase: p.confirm_phrase });
  assert.equal(done.wiped, 3);
  assert.equal(await live(store, 'acme/widget'), 0);
  assert.equal(((await store.wipeRepo({ repo: 'acme/widget' })) as any).entries, 0); // nothing left to wipe
  await assert.rejects(store.wipeRepo({ repo: 'acme/ghost' }), /no memory exists/);
});

test('locked repositories cannot be wiped or renamed until the admin unlocks them', async () => {
  const { store } = await fresh();
  await seedWidget(store, 2, 0);
  await store.lockRepo({ repo: 'acme/widget' });
  await assert.rejects(store.wipeRepo({ repo: 'acme/widget' }), /locked.*admin page/);
  await assert.rejects(store.renameRepo({ from: 'acme/widget', to: 'acme/gadget' }), /locked/);
  assert.equal(((await store.start({ repo: 'acme/widget' })) as any).locked, true);
  await store.unlockRepo('acme/widget');
  assert.equal(((await store.wipeRepo({ repo: 'acme/widget' })) as any).preview, true);
  await assert.rejects(store.lockRepo({ repo: 'acme/ghost' }), /no memory exists/);
});

test('rename fixes a typo, never merges two repositories', async () => {
  const { store } = await fresh();
  await store.save({ repo: 'acme/widgit', prompt: 'saved under a typo' });
  assert.equal(((await store.renameRepo({ from: 'acme/widgit', to: 'Acme/Widget' })) as any).renamed, true);
  assert.equal(await live(store, 'acme/widget'), 1);
  assert.equal(((await store.start({ repo: 'acme/widgit' })) as any).known, false);
  await store.save({ repo: 'acme/billing', prompt: 'x' });
  await assert.rejects(store.renameRepo({ from: 'acme/billing', to: 'acme/widget' }), /never merged/);
  await assert.rejects(store.renameRepo({ from: 'general', to: 'acme/x' }), /"general" cannot/);
});

// ---------------------------------------------------------------------------
// Level 3 (admin only) and the trash lifecycle
// ---------------------------------------------------------------------------

test('wipe all skips locked repositories and pinned entries unless told otherwise; batches restore across repositories', async () => {
  const { store } = await fresh();
  await seedWidget(store, 3, 1);
  await store.save({ repo: 'acme/billing', prompt: 'billing note' });
  await store.save({ repo: 'acme/vault', prompt: 'precious' });
  await store.lockRepo({ repo: 'acme/vault' });

  const w = await store.wipeAll({});
  assert.equal(w.wiped, 3); // 2 unpinned widget + 1 billing
  assert.equal(await live(store, 'acme/widget'), 1);
  assert.equal(await live(store, 'acme/vault'), 1);
  assert.equal((await store.restoreBatch(w.batch)).restored, 3);
  assert.equal(await live(store, 'acme/billing'), 1);

  const all = await store.wipeAll({ includeLocked: true, includePinned: true });
  assert.equal(all.wiped, 5);
  assert.equal(((await store.adminSummary()).live), 0);
  await assert.rejects(store.restoreBatch('nope'), /nothing in the trash/);
});

test('emptying the trash is permanent, can target one repository, and prunes repositories with nothing left', async () => {
  const { store, raw } = await fresh();
  await seedWidget(store, 2, 0);
  await store.save({ repo: 'acme/billing', prompt: 'billing note' });
  await store.wipeAll({});
  const rows = (repo: string) => (raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE project = ?').get(repo) as any).n;
  assert.equal((await store.emptyTrash({ repo: 'acme/widget' })).erased, 2);
  assert.equal(rows('acme/widget'), 0);
  assert.equal(rows('acme/billing'), 1); // still in the trash
  assert.equal((await store.repos({})).repos.some((r: any) => r.repo === 'acme/widget'), false);
  assert.equal((await store.emptyTrash({})).erased, 1);
  assert.equal((await store.search({ query: 'billing' })).count, 0);
  assert.equal((await store.repos({})).repos.some((r: any) => r.repo === 'general'), true); // never pruned
});

test('trash entries expire after the retention period', async () => {
  const { store, raw } = await fresh({ trashDays: 7 });
  const old = (await store.save({ repo: 'acme/widget', prompt: 'old trash' })).id;
  const recent = (await store.save({ repo: 'acme/widget', prompt: 'recent trash' })).id;
  await store.forget({ repo: 'acme/widget', id: old });
  await store.forget({ repo: 'acme/widget', id: recent });
  raw.prepare(`UPDATE memories SET deleted_at = datetime('now', '-8 days') WHERE id = ?`).run(old);
  raw.prepare(`UPDATE memories SET deleted_at = datetime('now', '-6 days') WHERE id = ?`).run(recent);
  assert.equal(await store.purgeExpiredTrash(), 1);
  assert.equal((await store.restore({ repo: 'acme/widget', id: recent })).restored, 1);
  await assert.rejects(store.restore({ repo: 'acme/widget', id: old }), /nothing in the trash/);
  assert.equal(await store.purgeExpiredTrash(), 0);
  const t: any = await store.trash({});
  assert.equal(t.retention_days, 7);
});

test('every removal is audited without storing entry content', async () => {
  const { store } = await fresh();
  const id = (await store.save({ repo: 'acme/widget', prompt: 'confidential words here' })).id;
  await store.forget({ repo: 'acme/widget', id });
  await store.save({ repo: 'acme/widget', prompt: 'second' });
  const p: any = await store.wipeRepo({ repo: 'acme/widget' });
  await store.wipeRepo({ repo: 'acme/widget', confirm_token: p.confirm_token, confirm_phrase: p.confirm_phrase });
  await store.wipeAll({}, 'admin');
  const audit = (await store.adminSummary()).audit;
  const actions = audit.map((a: any) => `${a.actor}:${a.action}`);
  for (const want of ['claude:forget_entry', 'claude:wipe_repo_preview', 'claude:wipe_repo', 'admin:wipe_all']) assert.ok(actions.includes(want), want);
  assert.ok(!JSON.stringify(audit).includes('confidential'));
});

// ---------------------------------------------------------------------------
// Upgrading an existing database
// ---------------------------------------------------------------------------

const V1_SCHEMA = [
  `CREATE TABLE memories (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL DEFAULT 'general', title TEXT NOT NULL, prompt TEXT NOT NULL,
     plan TEXT, result TEXT, status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','partial','failed')),
     tags TEXT, pinned INTEGER NOT NULL DEFAULT 0, supersedes INTEGER REFERENCES memories(id), deleted_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `INSERT INTO schema_versions(version) VALUES (1)`,
  `CREATE VIRTUAL TABLE memories_fts USING fts5(title, prompt, plan, result, tags, content='memories', content_rowid='id')`,
  `CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags) VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags); END`,
  `CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags) VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags); END`,
  `CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts,rowid,title,prompt,plan,result,tags) VALUES ('delete',old.id,old.title,old.prompt,old.plan,old.result,old.tags);
     INSERT INTO memories_fts(rowid,title,prompt,plan,result,tags) VALUES (new.id,new.title,new.prompt,new.plan,new.result,new.tags); END`,
];

test('an existing database is migrated: free-form projects fold into "general", breakdowns move under their repository', async () => {
  const { db, raw } = sqliteDb();
  for (const sql of V1_SCHEMA) raw.exec(sql);
  const ins = raw.prepare('INSERT INTO memories (project, title, prompt, tags) VALUES (?,?,?,?)');
  ins.run('lilyai', 'Old LilyAi work', 'legacy prompt about turso', null);
  ins.run('repo-breakdown', 'Breakdown: seizethewind/lilyai', 'breakdown prompt', 'seizethewind/lilyai,main,sha-abc1234');
  ins.run('repo-breakdown', 'Breakdown: unclear', 'breakdown prompt 2', 'whatever');
  ins.run('acme/app', 'Already a repo', 'p', 'x'); // legacy projects were always lowercased
  ins.run('general', 'General note', 'g', 'a,b');
  raw.prepare(`UPDATE memories SET deleted_at = datetime('now') WHERE title = 'General note'`).run();

  const store = new MemoryStore(db);
  await store.init();
  const row = (title: string) => raw.prepare('SELECT project, tags FROM memories WHERE title = ?').get(title) as any;
  assert.deepEqual({ ...row('Old LilyAi work') }, { project: 'general', tags: 'legacy-project:lilyai' });
  assert.deepEqual({ ...row('Breakdown: seizethewind/lilyai') }, { project: 'seizethewind/lilyai', tags: 'main,sha-abc1234,breakdown' });
  assert.deepEqual({ ...row('Breakdown: unclear') }, { project: 'general', tags: 'whatever,breakdown' });
  assert.deepEqual({ ...row('Already a repo') }, { project: 'acme/app', tags: 'x' }); // repo-shaped labels are kept as they are
  const repos = (await store.repos({})).repos.map((r: any) => r.repo).sort();
  assert.deepEqual(repos, ['acme/app', 'general', 'seizethewind/lilyai']);

  // old content is still searchable, and the deleted legacy row stays deleted
  assert.equal((await store.search({ query: 'turso' })).count, 1);
  assert.equal((await store.search({ query: 'turso', repo: 'general' })).count, 1);
  assert.equal((await store.start({ repo: 'seizethewind/lilyai' }) as any).entries, 1);
  assert.equal((raw.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as any).v, 2);

  // running it again changes nothing
  const again = new MemoryStore(db);
  await again.init();
  assert.equal(row('Old LilyAi work').tags, 'legacy-project:lilyai');
  assert.equal(row('Breakdown: seizethewind/lilyai').tags, 'main,sha-abc1234,breakdown');
});
