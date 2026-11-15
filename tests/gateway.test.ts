import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASIC_TOOLS, GATEWAY_TOOL_NAMES, buildGatewayTools, toolGroup, toolMode, unwrap, visibleTools } from '../src/gateway';

const mk = (name: string) => ({ name, description: `does ${name}`, inputSchema: { type: 'object' }, handler: async () => 'x' });
const ALL = [...BASIC_TOOLS, 'delete_file', 'pr_list', 'issue_create', 'issue_list', 'actions_runs', 'sandbox_create', 'blueprint_get'].map(mk);
const ANN: Record<string, Record<string, boolean>> = { pr_list: { readOnlyHint: true }, issue_list: { readOnlyHint: true }, actions_runs: { readOnlyHint: true }, delete_file: { destructiveHint: true }, issue_create: { readOnlyHint: false } };

test('mode defaults to gateway; only TOOL_MODE=full turns it off', () => {
  assert.equal(toolMode(undefined), 'gateway');
  assert.equal(toolMode('whatever'), 'gateway');
  assert.equal(toolMode('FULL'), 'full');
});

test('gateway mode lists basic + gateway tools; full mode lists everything but the gateway', () => {
  const tools = [...ALL, ...buildGatewayTools(() => ALL, () => ANN)];
  const g = visibleTools(tools, 'gateway').map((t) => t.name);
  assert.ok(GATEWAY_TOOL_NAMES.every((n) => g.includes(n)));
  assert.ok(!g.includes('issue_create') && !g.includes('delete_file'));
  assert.equal(g.length, BASIC_TOOLS.length + 3);
  const f = visibleTools(tools, 'full').map((t) => t.name);
  assert.ok(f.includes('issue_create') && !f.includes('find_tools'));
});

test('basic tools never include a merge/approve/dispatch tool or anything destructive beyond file writes', () => {
  for (const n of BASIC_TOOLS) assert.ok(!/merge|approve|dispatch|delete|wipe|forget/.test(n), n);
});

test('unwrap: read-only via use_tool, write via use_write_tool, everything else refused', () => {
  assert.deepEqual(unwrap('get_file_contents', { a: 1 }, ALL, ANN), { name: 'get_file_contents', args: { a: 1 } });
  assert.deepEqual(unwrap('use_tool', { name: 'issue_list', arguments: { owner: 'o' } }, ALL, ANN), { name: 'issue_list', args: { owner: 'o' } });
  assert.deepEqual(unwrap('use_tool', { name: 'issue_list' }, ALL, ANN), { name: 'issue_list', args: {} });
  assert.deepEqual(unwrap('use_write_tool', { name: 'issue_create', arguments: {} }, ALL, ANN).name, 'issue_create');
  assert.throws(() => unwrap('use_tool', { name: 'issue_create' }, ALL, ANN), /use_write_tool/);
  assert.throws(() => unwrap('use_tool', { name: 'delete_file' }, ALL, ANN), /not read-only/);
  assert.throws(() => unwrap('use_tool', { name: 'unannotated_missing' }, ALL, ANN), /Unknown tool/);
  assert.throws(() => unwrap('use_write_tool', { name: 'use_write_tool' }, ALL, ANN), /cannot be called/);
  assert.throws(() => unwrap('use_tool', { name: 'find_tools' }, ALL, ANN), /cannot be called/);
  assert.throws(() => unwrap('use_tool', {}, ALL, ANN), /required/);
  assert.throws(() => unwrap('use_tool', { name: 'issue_list', arguments: [] }, ALL, ANN), /object/);
});

test('a tool with no annotation is treated as a write tool', () => {
  assert.throws(() => unwrap('use_tool', { name: 'sandbox_create' }, ALL, ANN), /use_write_tool/);
});

test('find_tools lists only hidden tools, groups them, and says which door to use', async () => {
  const find = buildGatewayTools(() => ALL, () => ANN)[0];
  const overview = await find.handler({});
  assert.ok(overview.hidden_groups.issue.includes('issue_create'));
  assert.ok(!JSON.stringify(overview.hidden_groups).includes('get_file_contents'));
  const issue = await find.handler({ group: 'issue' });
  assert.deepEqual(issue.tools.map((t: any) => [t.name, t.call_with]).sort(), [['issue_create', 'use_write_tool'], ['issue_list', 'use_tool']]);
  const kw = await find.handler({ query: 'blueprint' });
  assert.equal(kw.tools.length, 1);
  assert.equal(toolGroup('sandbox_exec'), 'sandbox');
  assert.equal(toolGroup('delete_file'), 'repo');
});
