import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallGuard, callGuardFromEnv, auditLine } from '../src/guard';

test('all-calls limit: refused over the limit, per IP, and the refusal is not counted', () => {
  const g = createCallGuard({ perMin: 3, writePerMin: 0 });
  for (let i = 0; i < 3; i++) assert.equal(g.check('1.1.1.1', false), null);
  assert.match(g.check('1.1.1.1', false)!, /3 tool calls per minute/);
  assert.equal(g.check('2.2.2.2', false), null, 'another IP is unaffected');
});

test('write limit is tighter than the all-calls limit and only counts changing calls', () => {
  const g = createCallGuard({ perMin: 100, writePerMin: 2 });
  for (let i = 0; i < 50; i++) assert.equal(g.check('a', false), null, 'reads never hit the write limit');
  assert.equal(g.check('a', true), null);
  assert.equal(g.check('a', true), null);
  assert.match(g.check('a', true)!, /2 changing calls per minute/);
  assert.equal(g.check('a', false), null, 'reads still work while writes are limited');
});

test('0 switches a limit off; env parsing falls back to defaults on junk', () => {
  const off = createCallGuard({ perMin: 0, writePerMin: 0 });
  for (let i = 0; i < 500; i++) assert.equal(off.check('a', true), null);
  const g = callGuardFromEnv({ MCP_RATE_LIMIT_PER_MIN: 'abc', MCP_WRITE_LIMIT_PER_MIN: '-4' } as any);
  for (let i = 0; i < 30; i++) assert.equal(g.check('a', true), null);
  assert.match(g.check('a', true)!, /30 changing calls/);
});

test('audit line: names, paths and counts only; never contents or messages; errors are redacted and cut', () => {
  const line = auditLine({
    ip: '9.9.9.9',
    tool: 'push_files',
    via: 'use_write_tool',
    args: { owner: 'o', repo: 'r', branch: 'dev', message: 'SECRET COMMIT MESSAGE', files: [{ path: 'a', content: 'SECRET BODY' }, { path: 'b', content: 'x' }] },
    ok: true,
    now: new Date('2026-01-02T03:04:05Z'),
  });
  assert.ok(line.startsWith('[audit] '));
  const rec = JSON.parse(line.slice(8));
  assert.deepEqual(rec, { ts: '2026-01-02T03:04:05.000Z', ip: '9.9.9.9', tool: 'push_files', via: 'use_write_tool', repo: 'o/r', branch: 'dev', files: 2, result: 'ok' });
  assert.ok(!line.includes('SECRET'));
  const bad = JSON.parse(auditLine({ ip: 'i', tool: 'delete_file', args: { owner: 'o', repo: 'r', path: 'p', branch: 'b' }, ok: false, error: 'boom ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD ' + 'x'.repeat(500) }).slice(8));
  assert.equal(bad.result, 'error');
  assert.ok(!bad.error.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD'));
  assert.ok(bad.error.length <= 320);
  assert.equal(JSON.parse(auditLine({ ip: 'i', tool: 'pr_create', args: { owner: 'o', repo: 'r', head: 'h', base: 'main', number: 7 }, ok: true }).slice(8)).number, 7);
});
