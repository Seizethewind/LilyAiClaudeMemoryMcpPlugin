import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubCore } from '../src/github-core';
import { buildCoreTools } from '../src/core-tools';

/** The core file/branch tools against a fake GitHub: guard rails first, then the requests they make. */
function setup(opts: { allowed?: string[]; write?: string[]; defaultWrites?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const request = async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      if (method === 'GET' && /\/repos\/o\/r$/.test(path)) return { status: 200, body: { default_branch: 'main' } };
      if (method === 'GET' && path.includes('/contents/src/a.txt')) return { status: 200, body: { sha: 's1', path: 'src/a.txt', encoding: 'base64', content: Buffer.from('hello').toString('base64') } };
      if (method === 'GET' && path.includes('/contents/')) return { status: 200, body: [{ name: 'a.txt', path: 'a.txt', type: 'file', sha: 's', size: 5 }] };
      return { status: 200, body: {} };
  };
  const core = createGithubCore({
    token: 'dummy',
    allowedRepos: new Set(opts.allowed || ['o/*']),
    writeRepos: new Set(opts.write || opts.allowed || ['o/*']),
    allowDefaultBranchWrites: !!opts.defaultWrites,
    request,
  });
  const tools = buildCoreTools(core);
  const by = (n: string) => tools.find((t) => t.name === n)!;
  return { by, calls, core };
}

test('the core tool set is exactly the six file and branch tools', () => {
  const { by } = setup();
  assert.deepEqual(['get_file_contents', 'create_or_update_file', 'delete_file', 'list_branches', 'create_branch', 'push_files'].filter((n) => !by(n)), []);
});

test('get_file_contents decodes a file, lists a directory, and encodes the path per segment', async () => {
  const { by, calls } = setup();
  const file = await by('get_file_contents').handler({ owner: 'o', repo: 'r', path: 'src/a.txt', ref: 'dev branch' });
  assert.equal(file.content, 'hello');
  assert.equal(calls[0].path, '/repos/o/r/contents/src/a.txt?ref=dev%20branch');
  const dir = await by('get_file_contents').handler({ owner: 'o', repo: 'r', path: '' });
  assert.equal(dir.type, 'dir');
  assert.equal(dir.entries[0].name, 'a.txt');
});

test('reads outside ALLOWED_REPOS are refused before any request is made', async () => {
  const { by, calls } = setup({ allowed: ['o/r'] });
  await assert.rejects(() => by('get_file_contents').handler({ owner: 'x', repo: 'y', path: '' }), /not in ALLOWED_REPOS/);
  assert.equal(calls.length, 0);
});

test('writes: read-only repos and default-branch writes are refused, branch writes go through', async () => {
  const ro = setup({ allowed: ['o/*'], write: ['o/other'] });
  await assert.rejects(() => ro.by('create_or_update_file').handler({ owner: 'o', repo: 'r', path: 'a', content: 'x', message: 'm', branch: 'dev' }), /not in WRITE_REPOS/);
  assert.equal(ro.calls.length, 0);

  const s = setup();
  await assert.rejects(() => s.by('delete_file').handler({ owner: 'o', repo: 'r', path: 'a', message: 'm', branch: 'main' }), /default branch "main"/);
  await assert.rejects(() => s.by('create_or_update_file').handler({ owner: 'o', repo: 'r', path: 'a', content: 'x', message: 'm' }), /default branch/);
  assert.ok(s.calls.every((c) => c.method === 'GET'), 'only the default-branch lookup was made, no write');

  const ok = await s.by('create_or_update_file').handler({ owner: 'o', repo: 'r', path: 'a.txt', content: 'x', message: 'm', branch: 'dev' }).catch((e: any) => e);
  assert.ok(s.calls.some((c) => c.method === 'PUT' && c.path.includes('/contents/a.txt')), String(ok));

  const open = setup({ defaultWrites: true });
  await open.by('create_or_update_file').handler({ owner: 'o', repo: 'r', path: 'a.txt', content: 'x', message: 'm', branch: 'main' }).catch(() => {});
  assert.ok(open.calls.some((c) => c.method === 'PUT'), 'ALLOW_DEFAULT_BRANCH_WRITES lets it through');
});
