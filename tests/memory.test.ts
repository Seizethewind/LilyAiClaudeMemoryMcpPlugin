import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, buildMemoryTools, redact, type Db } from '../src/memory';

// Test adapter: node:sqlite behind the same interface the libSQL client satisfies.
function sqliteDb(): Db {
  const raw = new DatabaseSync(':memory:');
  return {
    async execute({ sql, args = [] }) {
      const st = raw.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        const objs = st.all(...args) as Record<string, any>[];
        const columns = objs.length ? Object.keys(objs[0]) : [];
        return { columns, rows: objs.map((o) => columns.map((c) => o[c])) };
      }
      const r = st.run(...args);
      return { columns: [], rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: Number(r.changes) };
    },
  };
}

const R = 'acme/app';

async function fresh() {
  const store = new MemoryStore(sqliteDb());
  await store.init();
  return store;
}

test('FTS5 is active and save -> update -> get roundtrip works', async () => {
  const s = await fresh();
  assert.equal(s.ftsEnabled, true);
  const { id } = await s.save({ repo: 'Seizethewind/LilyAi', prompt: 'Add Turso memory to the MCP bridge', plan: 'Port schema, add tools' });
  let got = (await s.get({ id })).memories[0];
  assert.equal(got.status, 'planned');
  assert.equal(got.repo, 'seizethewind/lilyai');
  assert.equal(got.result, null);
  await s.update({ id, result: 'Built and tested', });
  got = (await s.get({ id })).memories[0];
  assert.equal(got.status, 'done');
  assert.equal(got.result, 'Built and tested');
});

test('search finds by prompt, plan and result; prefix + OR fallback; repo filter', async () => {
  const s = await fresh();
  const a = (await s.save({ repo: 'seizethewind/lilyai', prompt: 'Add Turso memory', plan: 'use libsql client' })).id;
  const b = (await s.save({ repo: 'seizethewind/umakraft', prompt: 'Fix Discord bot slash command', plan: 'check intents' })).id;
  await s.update({ id: b, result: 'Missing guild scope was the cause', status: 'done' });
  assert.deepEqual((await s.search({ query: 'turso' })).results.map((r: any) => r.id), [a]);
  assert.deepEqual((await s.search({ query: 'guild scope' })).results.map((r: any) => r.id), [b]);
  assert.deepEqual((await s.search({ query: 'libs' })).results.map((r: any) => r.id), [a]); // prefix
  assert.equal((await s.search({ query: 'turso discord' })).count, 2); // OR fallback
  assert.equal((await s.search({ query: 'turso', repo: 'seizethewind/umakraft' })).count, 0);
});

test('search index follows updates and soft deletes; FTS special chars are safe', async () => {
  const s = await fresh();
  const { id } = await s.save({ repo: R, prompt: 'alpha topic' });
  await s.update({ id, result: 'zebra outcome' });
  assert.equal((await s.search({ query: 'zebra' })).count, 1);
  const nasty = ['"; DR', 'OP TABLE memories; --'].join('');
  assert.equal((await s.search({ query: nasty })).count, 0);
  assert.equal((await s.search({ query: 'zebra' })).count, 1); // table still intact
  await s.forget({ repo: R, id });
  assert.equal((await s.search({ query: 'zebra' })).count, 0);
  assert.equal((await s.get({ id })).count, 0);
});

test('supersedes links entries; timeline pages and shows pinned', async () => {
  const s = await fresh();
  const old = (await s.save({ repo: R, prompt: 'old approach', pinned: true })).id;
  const neu = (await s.save({ repo: R, prompt: 'new approach', supersedes: old })).id;
  const tl = await s.timeline({});
  assert.equal(tl.results[0].id, neu);
  assert.equal(tl.results.find((r: any) => r.id === old).superseded_by, neu);
  assert.equal(tl.pinned.length, 1);
  for (let i = 0; i < 5; i++) await s.save({ repo: R, prompt: `filler ${i}` });
  const p1 = await s.timeline({ limit: 3 });
  const p2 = await s.timeline({ limit: 3, before_id: p1.next_before_id });
  assert.equal(p1.results.length, 3);
  assert.ok(p2.results[0].id < p1.results[2].id);
  await assert.rejects(s.save({ repo: R, prompt: 'x', supersedes: 999 }), /not found/);
});

test('secrets are redacted before storage', async () => {
  const s = await fresh();
  const fakeGh = 'ghp_' + 'a'.repeat(36);
  const fakeJwt = 'eyJhbGciOiJFZERTQSJ9.' + 'b'.repeat(30) + '.' + 'c'.repeat(30);
  const r = await s.save({
    repo: R, prompt: `token ${fakeGh} and TURSO_AUTH_TOKEN=${fakeJwt} and password: hunter2hunter2`,
    plan: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
  });
  assert.ok(r.redactions >= 4);
  const m = (await s.get({ id: r.id })).memories[0];
  for (const bad of [fakeGh, fakeJwt, 'hunter2hunter2', 'MIIabc']) {
    assert.ok(!m.prompt.includes(bad) && !m.plan.includes(bad), bad);
  }
  assert.equal(redact('nothing secret here').count, 0);
});

test('validation: status, empty update, caps, tools list', async () => {
  const s = await fresh();
  const { id } = await s.save({ repo: R, prompt: 'x'.repeat(9000) });
  assert.ok((await s.get({ id })).memories[0].prompt.length < 8100);
  await assert.rejects(s.update({ id, status: 'bogus' }), /status must be/);
  await assert.rejects(s.update({ id }), /nothing to update/);
  await assert.rejects(s.update({ id: 12345, result: 'r' }), /not found/);
  await assert.rejects(s.save({ repo: R, prompt: '   ' }), /prompt is required/);
  const names = buildMemoryTools(s).map((t) => t.name);
  assert.deepEqual(names, [
    'memory_start', 'memory_repos', 'memory_save', 'memory_update', 'memory_search', 'memory_timeline', 'memory_get',
    'memory_forget', 'memory_wipe_repo', 'memory_trash', 'memory_restore', 'memory_lock_repo', 'memory_rename_repo',
    'blueprint_get', 'blueprint_save', 'blueprint_history',
  ]);
  await assert.rejects(s.save({ prompt: 'no repo' }), /repo is required/);
});

test('LIKE fallback when FTS5 is unavailable', async () => {
  const s = await fresh();
  s.ftsEnabled = false;
  await s.save({ repo: R, prompt: 'fallback search works', plan: 'p' });
  assert.equal((await s.search({ query: 'fallback' })).count, 1);
  assert.match(await s.exportJsonl(), /fallback search works/);
});

test('a secret straddling the length cap is redacted, not stored in part', async () => {
  const s = await fresh();
  const secret = 'ghp_' + 'z'.repeat(36);
  const { id } = await s.save({ repo: R, prompt: 'a'.repeat(7990) + ' ' + secret });
  const m = (await s.get({ id })).memories[0];
  assert.ok(!m.prompt.includes('ghp_'), 'no fragment of the token may survive truncation');
  assert.ok(m.prompt.includes('[REDACTED'), 'marker (possibly itself cut by the cap) replaces the token');
  assert.ok(!m.prompt.includes('zzzz'));
});

test('tags are redacted too, and a secret can never be stored as a repository name', async () => {
  const s = await fresh();
  const key = 'AKIA' + 'A'.repeat(16);
  const { id } = await s.save({ repo: R, prompt: 'x', tags: [key, 'ok'] });
  const m = (await s.get({ id })).memories[0];
  assert.ok(!String(m.tags).toLowerCase().includes('akia'));
  assert.ok(String(m.tags).includes('ok'));
  // repository names are validated (owner/name), so free text such as a token is refused outright
  await assert.rejects(s.save({ repo: 'ghp_' + 'q'.repeat(36), prompt: 'x' }), /valid repository name/);
});
