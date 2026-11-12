import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, type Db } from '../src/memory';

// Same test adapter as memory.test.ts, but keeps the raw handle for direct row checks.
function sqliteDb() {
  const raw = new DatabaseSync(':memory:');
  const db: Db = {
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
  return { db, raw };
}

async function fresh() {
  const { db, raw } = sqliteDb();
  const store = new MemoryStore(db);
  await store.init();
  return { store, raw };
}

test('append_result adds to the result without replacing it or changing status', async () => {
  const { store } = await fresh();
  const { id } = await store.save({ prompt: 'long task' });
  await store.update({ id, append_result: 'step 1 done' });
  await store.update({ id, append_result: 'step 2 done' });
  let m = (await store.get({ id })).memories[0];
  assert.equal(m.result, 'step 1 done\nstep 2 done');
  assert.equal(m.status, 'planned');
  await store.update({ id, append_result: 'all finished', status: 'done' });
  m = (await store.get({ id })).memories[0];
  assert.equal(m.result, 'step 1 done\nstep 2 done\nall finished');
  assert.equal(m.status, 'done');
  assert.equal((await store.search({ query: 'finished' })).count, 1); // search index follows appends
});

test('append_result is redacted, capped, and cannot be combined with result', async () => {
  const { store } = await fresh();
  const { id } = await store.save({ prompt: 'x' });
  const r = await store.update({ id, append_result: 'key ghp_' + 'a'.repeat(36) });
  assert.ok(r.redactions >= 1);
  assert.ok(!(await store.get({ id })).memories[0].result.includes('ghp_'));
  await store.update({ id, append_result: 'y'.repeat(7000) });
  await store.update({ id, append_result: 'z'.repeat(7000) });
  assert.ok((await store.get({ id })).memories[0].result.length <= 8000);
  await assert.rejects(store.update({ id, result: 'a', append_result: 'b' }), /either result or append_result/);
});

test('soft-forgotten entries are left out of the backup export; hard forget erases the row', async () => {
  const { store, raw } = await fresh();
  const keep = (await store.save({ prompt: 'keep me' })).id;
  const soft = (await store.save({ prompt: 'soft forgotten secret-ish note' })).id;
  const hard = (await store.save({ prompt: 'hard forgotten note' })).id;
  await store.forget({ id: soft });
  const exported = await store.exportJsonl();
  assert.match(exported, /keep me/);
  assert.doesNotMatch(exported, /soft forgotten/);
  // soft delete keeps the row; hard delete removes it and its search index entry
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(soft) as any).n, 1);
  const out: any = await store.forget({ id: hard, hard: true });
  assert.match(out.deleted, /^hard/);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(hard) as any).n, 0);
  assert.equal((await store.search({ query: 'hard' })).count, 0);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(keep) as any).n, 1);
  await assert.rejects(store.forget({ id: hard, hard: true }), /not found/);
});

test('hard forget keeps entries that superseded the erased one', async () => {
  const { store } = await fresh();
  const old = (await store.save({ prompt: 'old approach' })).id;
  const neu = (await store.save({ prompt: 'new approach', supersedes: old })).id;
  await store.forget({ id: old, hard: true });
  assert.equal((await store.get({ id: neu })).count, 1);
});

test('title matches outrank body matches', async () => {
  const { store } = await fresh();
  const body = (await store.save({ title: 'unrelated heading', prompt: 'we discussed zanzibar at length in the body text' })).id;
  const title = (await store.save({ title: 'Zanzibar trip', prompt: 'planning' })).id;
  const ids = (await store.search({ query: 'zanzibar' })).results.map((r: any) => r.id);
  assert.deepEqual(ids, [title, body]);
});
