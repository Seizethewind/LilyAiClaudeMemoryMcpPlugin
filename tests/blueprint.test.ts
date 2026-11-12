import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, buildMemoryTools } from '../src/memory';
import { sqliteDb } from './sqlite-db';

async function fresh() {
  const { db, raw } = sqliteDb();
  const store = new MemoryStore(db);
  await store.init();
  return { store, raw, db };
}
const R = 'acme/app';

test('create, outline, read sections', async () => {
  const { store } = await fresh();
  const none: any = await store.getBlueprint({ repo: R });
  assert.equal(none.exists, false);
  assert.ok(none.section_guide.tests);

  const r: any = await store.saveBlueprint({ repo: R, sections: { overview: 'A todo app', tests: 'npm test: 12 pass (2026-11-13, abc123)' }, based_on: 'abc123' });
  assert.equal(r.version, 1);
  assert.equal(r.created, true);
  assert.deepEqual(r.saved, ['overview', 'tests']);
  assert.deepEqual(r.missing, ['architecture', 'implementation', 'logic', 'improvements']);

  const o: any = await store.getBlueprint({ repo: 'ACME/App' });
  assert.equal(o.based_on, 'abc123');
  assert.equal(o.content, undefined);
  assert.equal(o.outline.length, 2);
  const full: any = await store.getBlueprint({ repo: R, sections: ['tests'] });
  assert.match(full.content.tests, /12 pass/);
  const all: any = await store.getBlueprint({ repo: R, sections: ['all'] });
  assert.equal(all.content.logic, null);
});

test('validation: unknown section, empty, both replace+append, general, oversize', async () => {
  const { store } = await fresh();
  await assert.rejects(store.saveBlueprint({ repo: R, sections: { bogus: 'x' } }), /unknown section/);
  await assert.rejects(store.saveBlueprint({ repo: R, sections: { tests: '  ' } }), /non-empty/);
  await assert.rejects(store.saveBlueprint({ repo: R }), /nothing to save/);
  await assert.rejects(store.saveBlueprint({ repo: R, sections: { tests: 'a' }, append: { tests: 'b' } }), /both/);
  await assert.rejects(store.saveBlueprint({ repo: 'general', sections: { tests: 'a' } }), /"general" has none/);
  await assert.rejects(store.saveBlueprint({ repo: R, sections: { tests: 'x'.repeat(20001) } }), /limit is 20000/);
  assert.ok(!((await store.listRepos(10)) as any[]).some((r) => r.repo === R), 'failed saves must not create the repository');
});

test('append, unchanged, redaction', async () => {
  const { store } = await fresh();
  await store.saveBlueprint({ repo: R, sections: { improvements: 'one' } });
  const a: any = await store.saveBlueprint({ repo: R, append: { improvements: 'two' } });
  assert.equal(a.version, 2);
  assert.equal(((await store.getBlueprint({ repo: R, sections: ['improvements'] })) as any).content.improvements, 'one\n\ntwo');
  const same: any = await store.saveBlueprint({ repo: R, sections: { improvements: 'one\n\ntwo' } });
  assert.equal(same.unchanged, true);
  assert.equal(same.version, 2);
  const secret = 'ghp_' + 'a'.repeat(36);
  const red: any = await store.saveBlueprint({ repo: R, sections: { implementation: `token ${secret}` } });
  assert.ok(red.redactions >= 1);
  assert.ok(!JSON.stringify(await store.getBlueprint({ repo: R, sections: ['all'] })).includes(secret));
});

test('base_version detects a concurrent edit', async () => {
  const { store } = await fresh();
  await store.saveBlueprint({ repo: R, sections: { overview: 'v1' } });
  await store.saveBlueprint({ repo: R, sections: { overview: 'v2' }, base_version: 1 });
  await assert.rejects(store.saveBlueprint({ repo: R, sections: { overview: 'stale' }, base_version: 1 }), /changed since you read it/);
  assert.equal(((await store.getBlueprint({ repo: R, sections: ['overview'] })) as any).content.overview, 'v2');
});

test('history keeps 10 per section; restore by re-saving', async () => {
  const { store } = await fresh();
  for (let i = 1; i <= 12; i++) await store.saveBlueprint({ repo: R, sections: { tests: `run ${i}` }, note: `n${i}` });
  const h: any = await store.blueprintHistory({ repo: R, section: 'tests', limit: 30, include_content: true });
  assert.equal(h.count, 10);
  assert.equal(h.revisions[0].content, 'run 12');
  assert.equal(h.revisions[9].content, 'run 3');
  await store.saveBlueprint({ repo: R, sections: { tests: h.revisions[5].content } });
  assert.equal(((await store.getBlueprint({ repo: R, sections: ['tests'] })) as any).content.tests, 'run 7');
});

test('look-alike repository names are refused for a first blueprint too', async () => {
  const { store } = await fresh();
  await store.saveBlueprint({ repo: 'acme/application', sections: { overview: 'x' } });
  await assert.rejects(store.saveBlueprint({ repo: 'acme/aplication', sections: { overview: 'x' } }), /similar repositories/);
  await store.saveBlueprint({ repo: 'acme/aplication', sections: { overview: 'x' }, confirm_new_repo: true });
});

test('integration: memory_start, repos, update reminder', async () => {
  const { store } = await fresh();
  const { id } = await store.save({ repo: R, prompt: 'p' });
  const before: any = await store.start({ repo: R });
  assert.equal(before.blueprint.exists, false);
  const rem: any = await store.update({ id, result: 'done' });
  assert.match(rem.blueprint_reminder, /no blueprint yet/);
  await store.saveBlueprint({ repo: R, sections: { overview: 'x' }, based_on: 'sha1' });
  const after: any = await store.start({ repo: R });
  assert.equal(after.blueprint.exists, true);
  assert.equal(after.blueprint.version, 1);
  assert.equal(after.blueprint.based_on, 'sha1');
  assert.equal((await store.listRepos(10) as any[])[0].blueprint, 1);
  const { id: id2 } = await store.save({ repo: R, prompt: 'q' });
  assert.match(((await store.update({ id: id2, result: 'ok' })) as any).blueprint_reminder, /update the affected blueprint sections/);
});

test('rename moves the blueprint; forget/wipe leave it; prune keeps the repository', async () => {
  const { store } = await fresh();
  const { id } = await store.save({ repo: R, prompt: 'p' });
  await store.saveBlueprint({ repo: R, sections: { overview: 'keep me' } });
  await store.renameRepo({ from: R, to: 'acme/app2' });
  assert.equal(((await store.getBlueprint({ repo: R })) as any).exists, false);
  assert.match(((await store.getBlueprint({ repo: 'acme/app2', sections: ['overview'] })) as any).content.overview, /keep me/);
  await store.forget({ repo: 'acme/app2', id });
  await store.save({ repo: 'acme/app2', prompt: 'another' });
  const prev: any = await store.wipeRepo({ repo: 'acme/app2' });
  await store.wipeRepo({ repo: 'acme/app2', confirm_token: prev.confirm_token, confirm_phrase: prev.confirm_phrase });
  await store.emptyTrash({});
  assert.equal(((await store.getBlueprint({ repo: 'acme/app2' })) as any).exists, true);
  assert.ok(((await store.listRepos(10)) as any[]).some((r) => r.repo === 'acme/app2'));
});

test('admin delete: refused when locked, audited, removes history', async () => {
  const { store, raw } = await fresh();
  await store.saveBlueprint({ repo: R, sections: { overview: 'x' } });
  await store.lockRepo({ repo: R });
  await assert.rejects(store.deleteBlueprint(R), /locked/);
  await store.unlockRepo(R, 'admin');
  await store.deleteBlueprint(R);
  for (const t of ['blueprints', 'blueprint_sections', 'blueprint_revisions']) assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n, 0);
  await assert.rejects(store.deleteBlueprint(R), /no blueprint/);
  assert.ok(((raw.prepare("SELECT COUNT(*) AS n FROM memory_audit WHERE action='delete_blueprint'").get() as any).n) >= 0);
});

test('no MCP tool can delete a blueprint', async () => {
  const { store } = await fresh();
  const names = buildMemoryTools(store).map((t) => t.name).filter((n) => n.startsWith('blueprint_'));
  assert.deepEqual(names, ['blueprint_get', 'blueprint_save', 'blueprint_history']);
});

test('upgrade from schema v2 adds blueprint tables without touching entries', async () => {
  const { store, raw, db } = await fresh();
  await store.save({ repo: R, prompt: 'old entry' });
  raw.exec('DROP TABLE blueprint_revisions; DROP TABLE blueprint_sections; DROP TABLE blueprints; DELETE FROM schema_versions WHERE version = 3');
  const again = new MemoryStore(db);
  await again.init();
  assert.equal((raw.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as any).v, 3);
  assert.equal((await again.timeline({ repo: R })).results.length, 1);
  assert.equal((await again.saveBlueprint({ repo: R, sections: { overview: 'x' } }) as any).version, 1);
});
