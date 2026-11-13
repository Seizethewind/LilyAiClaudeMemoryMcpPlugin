import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxTools, PandaStackClient, sandboxOptionsFromEnv, SANDBOX_ANNOTATIONS } from '../src/sandbox';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };

// Scripted fake of PandaStack: each handler gets the call and returns [status, body, headers?].
function fake(handler: (c: Call, n: number) => [number, any, Record<string, string>?]) {
  const calls: Call[] = [];
  const fetchImpl: any = async (url: URL, init: any) => {
    const call: Call = { method: init.method, url: new URL(String(url)), headers: init.headers, body: init.body };
    calls.push(call);
    const [status, body, headers] = handler(call, calls.length);
    const isBytes = Buffer.isBuffer(body);
    const text = isBytes ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const empty = status === 204 || status === 205 || status === 304; // these statuses must not carry a body
    return new Response(empty ? null : isBytes ? body : text, { status, headers: headers || {} });
  };
  return { calls, fetchImpl };
}

const sleep = async () => {};
const tools = (opts: any) => {
  const list = buildSandboxTools({ apiKey: 'pds_secret', sleep, ...opts });
  return { list, by: (n: string) => list.find((t) => t.name === n)! };
};

test('no api key means no tools, key means all of them annotated', () => {
  assert.deepEqual(buildSandboxTools({ apiKey: '' }), []);
  const { list } = tools({ fetchImpl: fake(() => [200, []]).fetchImpl });
  assert.equal(list.length, 11);
  for (const t of list) assert.ok(SANDBOX_ANNOTATIONS[t.name], `${t.name} has annotations`);
  assert.equal(new Set(list.map((t) => t.name)).size, list.length);
});

test('env: key alias, numbers, junk ignored', () => {
  const o = sandboxOptionsFromEnv({ PANDASTACK_TOKEN: 'pds_x', SANDBOX_MAX_ACTIVE: '5', SANDBOX_MAX_TTL_SECONDS: 'abc' } as any);
  assert.equal(o.apiKey, 'pds_x');
  assert.equal(o.maxActive, 5);
  assert.equal(o.maxTtlSeconds, undefined);
});

test('preview host is derived from the API host, or overridden', () => {
  assert.equal(new PandaStackClient({ apiKey: 'k' }).previewUrl('abc', 3000), 'https://3000-abc.pandastack.ai');
  assert.equal(new PandaStackClient({ apiKey: 'k', apiUrl: 'https://api.acme.dev/' }).previewUrl('abc', 80), 'https://80-abc.acme.dev');
  assert.equal(new PandaStackClient({ apiKey: 'k', previewHost: 'p.example.com' }).previewUrl('abc', 1), 'https://1-abc.p.example.com');
});

test('create: defaults to browser, clamps ttl, forces our metadata tag, sends bearer', async () => {
  const f = fake((c) => (c.method === 'GET' ? [200, []] : [201, { id: 'sb1', status: 'running', template: 'browser' }]));
  const { by } = tools({ fetchImpl: f.fetchImpl, maxTtlSeconds: 1800 });
  const r: any = await by('sandbox_create').handler({ ttl_seconds: 999999, metadata: { job: 'x', source: 'evil', n: 5 } });
  const post = f.calls.find((c) => c.method === 'POST')!;
  const sent = JSON.parse(post.body);
  assert.equal(sent.template, 'browser');
  assert.equal(sent.ttl_seconds, 1800);
  assert.deepEqual(sent.metadata, { job: 'x', source: 'lily-mcp' });
  assert.equal(post.headers.Authorization, 'Bearer pds_secret');
  assert.equal(r.id, 'sb1');
  assert.equal(r.ttl_seconds, 1800);
  assert.equal(r.preview_url_example, 'https://3000-sb1.pandastack.ai');
});

test('create: refuses past the cap, counting only our live sandboxes', async () => {
  const rows = [
    { id: 'a', status: 'running', metadata: { source: 'lily-mcp' } },
    { id: 'b', status: 'paused', metadata: { source: 'lily-mcp' } },
    { id: 'c', status: 'deleted', metadata: { source: 'lily-mcp' } },
    { id: 'd', status: 'running', metadata: { source: 'someone-else' } },
  ];
  const f = fake(() => [200, { sandboxes: rows }]);
  const { by } = tools({ fetchImpl: f.fetchImpl, maxActive: 2 });
  await assert.rejects(by('sandbox_create').handler({}), /limit reached \(2\/2/);
  assert.ok(!f.calls.some((c) => c.method === 'POST'), 'must not even try to create');
  const ok = tools({ fetchImpl: fake((c) => (c.method === 'GET' ? [200, rows] : [201, { id: 'n' }])).fetchImpl, maxActive: 3 });
  assert.equal(((await ok.by('sandbox_create').handler({})) as any).id, 'n');
});

test('create: retries a capacity 503 that carries Retry-After, but never a bare 500', async () => {
  let posts = 0;
  const f = fake((c) => {
    if (c.method === 'GET') return [200, []];
    posts++;
    return posts < 3 ? [503, { error: 'no compute capacity available' }, { 'retry-after': '5' }] : [201, { id: 'ok' }];
  });
  assert.equal(((await tools({ fetchImpl: f.fetchImpl }).by('sandbox_create').handler({})) as any).id, 'ok');
  assert.equal(posts, 3);

  let p2 = 0;
  const g = fake((c) => (c.method === 'GET' ? [200, []] : (p2++, [500, { error: 'boom' }])));
  await assert.rejects(tools({ fetchImpl: g.fetchImpl }).by('sandbox_create').handler({}), /PandaStack 500: boom/);
  assert.equal(p2, 1, 'a 500 may have created the sandbox, so it must not be retried');
});

test('errors carry the flat error + detail and never leak the key', async () => {
  const f = fake(() => [401, { error: 'unauthorized', detail: 'invalid api token' }]);
  await assert.rejects(tools({ fetchImpl: f.fetchImpl }).by('sandbox_get').handler({ id: 'sb1' }), (e: any) => {
    assert.match(e.message, /PandaStack 401: unauthorized - invalid api token/);
    assert.ok(!e.message.includes('pds_secret'));
    assert.equal(e.isToolError, true);
    return true;
  });
});

test('exec: sends cmd and timeout, clamps timeout, truncates output', async () => {
  const f = fake(() => [200, { stdout: 'x'.repeat(25000), stderr: 'warn', exit_code: 3, duration_ms: 12 }]);
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const r: any = await by('sandbox_exec').handler({ id: 'sb1', cmd: 'echo hi', timeout_seconds: 99999 });
  assert.deepEqual(JSON.parse(f.calls[0].body), { cmd: 'echo hi', timeout_seconds: 300 });
  assert.equal(f.calls[0].url.pathname, '/v1/sandboxes/sb1/exec');
  assert.equal(r.exit_code, 3);
  assert.equal(r.stdout.length, 20000);
  assert.equal(r.stdout_truncated_from, 25000);
  assert.equal(r.stderr, 'warn');
  await assert.rejects(by('sandbox_exec').handler({ id: 'sb1', cmd: '  ' }), /cmd is required/);
});

test('ids and paths are validated before any request is made', async () => {
  const f = fake(() => [200, {}]);
  const { by } = tools({ fetchImpl: f.fetchImpl });
  await assert.rejects(by('sandbox_get').handler({ id: '../x' }), /Invalid sandbox id/);
  await assert.rejects(by('sandbox_delete').handler({ id: 'a/b' }), /Invalid sandbox id/);
  await assert.rejects(by('sandbox_write_file').handler({ id: 's', path: 'relative.txt', content: 'x' }), /absolute path/);
  await assert.rejects(by('sandbox_read_file').handler({ id: 's', path: '/a\0b' }), /absolute path/);
  await assert.rejects(by('sandbox_preview_url').handler({ id: 's', port: 70000 }), /port must be/);
  assert.equal(f.calls.length, 0);
});

test('files: write sends raw bytes (base64 decoded), read truncates and encodes', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
  const f = fake((c) => (c.method === 'PUT' ? [200, { path: '/workspace/a.bin', bytes: 10 }] : [200, png]));
  const { by } = tools({ fetchImpl: f.fetchImpl });
  await by('sandbox_write_file').handler({ id: 's', path: '/workspace/a.bin', content: png.toString('base64'), encoding: 'base64' });
  assert.equal(f.calls[0].method, 'PUT');
  assert.equal(f.calls[0].url.searchParams.get('path'), '/workspace/a.bin');
  assert.deepEqual(Buffer.from(f.calls[0].body), png);
  const r: any = await by('sandbox_read_file').handler({ id: 's', path: '/workspace/a.bin', encoding: 'base64', max_bytes: 4 });
  assert.equal(r.bytes, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.content, png.subarray(0, 4).toString('base64'));
});

test('preview url tool builds the link and warns it is public', async () => {
  const r: any = await tools({ fetchImpl: fake(() => [200, {}]).fetchImpl }).by('sandbox_preview_url').handler({ id: 'sb1', port: 8080 });
  assert.equal(r.url, 'https://8080-sb1.pandastack.ai');
  assert.match(r.warning, /Public/);
});

test('screenshot: job goes in as JSON (never into a command), only http(s), parses the result', async () => {
  const f = fake((c) => {
    if (c.method === 'PUT') return [200, { bytes: 1 }];
    return [200, { stdout: 'noise\n' + JSON.stringify({ ok: true, status: 200, title: 'Example', final_url: 'https://example.com/', text: 'hello' }), stderr: '', exit_code: 0 }];
  });
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const evil = 'https://example.com/?q=$(rm -rf /)';
  const r: any = await by('sandbox_browser_screenshot').handler({ id: 'sb1', url: evil, extract_text: true, width: 99999 });
  const job = JSON.parse(Buffer.from(f.calls[0].body).toString());
  assert.ok(job.url.includes('rm'), 'url is data inside the job file');
  assert.equal(job.width, 3840);
  assert.equal(job.extract_text, true);
  const exec = JSON.parse(f.calls[2].body);
  assert.equal(exec.cmd, 'python3 /workspace/.lily/shot.py');
  assert.ok(!exec.cmd.includes('rm'), 'caller text never reaches the shell command');
  assert.equal(r.title, 'Example');
  assert.equal(r.text, 'hello');
  assert.equal(r.screenshot_path, '/workspace/shot.png');
  await assert.rejects(by('sandbox_browser_screenshot').handler({ id: 'sb1', url: 'file:///etc/passwd' }), /Only http and https/);
  await assert.rejects(by('sandbox_browser_screenshot').handler({ id: 'sb1', url: 'not a url' }), /valid URL/);
});

test('screenshot: a failing script becomes a readable tool error', async () => {
  const f = fake((c) => (c.method === 'PUT' ? [200, {}] : [200, { stdout: '', stderr: "ModuleNotFoundError: No module named 'playwright'", exit_code: 1 }]));
  await assert.rejects(
    tools({ fetchImpl: f.fetchImpl }).by('sandbox_browser_screenshot').handler({ id: 'sb1', url: 'https://example.com' }),
    /Screenshot failed \(exit 1\).*"browser" template.*playwright/s
  );
});

test('delete and list', async () => {
  const f = fake((c) => (c.method === 'DELETE' ? [204, ''] : [200, [{ id: 'a' }]]));
  const { by } = tools({ fetchImpl: f.fetchImpl });
  assert.deepEqual(await by('sandbox_delete').handler({ id: 'sb1' }), { deleted: 'sb1' });
  assert.deepEqual(await by('sandbox_list').handler({}), { sandboxes: [{ id: 'a' }] });
});
