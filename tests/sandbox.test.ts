import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxTools, PandaStackClient, parseKeys, sandboxOptionsFromEnv, SANDBOX_ANNOTATIONS } from '../src/sandbox';

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
  const list = buildSandboxTools({ apiKey: 'pds_secret', sleep, toolset: 'full', ...opts });
  return { list, by: (n: string) => list.find((t) => t.name === n)! };
};

test('no api key means no tools, key means all of them annotated', () => {
  assert.deepEqual(buildSandboxTools({ apiKey: '' }), []);
  const { list } = tools({ fetchImpl: fake(() => [200, []]).fetchImpl });
  assert.ok(list.length >= 50, `expected the full tool set, got ${list.length}`);
  for (const n of ['web_search', 'web_fetch', 'sandbox_snapshot_create', 'sandbox_fork', 'volume_create', 'database_query', 'app_deploy', 'pandastack_api', 'pandastack_status']) assert.ok(list.some((t) => t.name === n), n);
  for (const t of list) assert.ok(SANDBOX_ANNOTATIONS[t.name], `${t.name} has annotations`);
  assert.equal(new Set(list.map((t) => t.name)).size, list.length);
  assert.equal(buildSandboxTools({ apiKey: ' , ,' }).length, 0, 'only separators is no key');
  assert.ok(buildSandboxTools({ apiKey: 'a,b' }).length > 0);
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
  assert.match(exec.cmd, /^python3 \/workspace\/\.lily\/run\.py \/workspace\/\.lily\/job-[0-9a-f]{12}\.json;/);
  assert.ok(!exec.cmd.includes('example.com') && !exec.cmd.includes('$('), 'caller text never reaches the shell command');
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
    /Browser job failed \(exit 1\).*"browser" template.*playwright/s
  );
});

test('delete and list', async () => {
  const f = fake((c) => (c.method === 'DELETE' ? [204, ''] : [200, [{ id: 'a' }]]));
  const { by } = tools({ fetchImpl: f.fetchImpl });
  assert.deepEqual(await by('sandbox_delete').handler({ id: 'sb1' }), { deleted: 'sb1' });
  assert.deepEqual(await by('sandbox_list').handler({}), { sandboxes: [{ id: 'a' }] });
});

const authOf = (c: Call) => c.headers.Authorization;

test('parseKeys: commas, spaces, quotes, blanks and repeats', () => {
  assert.deepEqual(parseKeys(' k1, "k2" ,,k3;k1 \n k4 '), ['k1', 'k2', 'k3', 'k4']);
  assert.deepEqual(parseKeys(''), []);
  assert.deepEqual(parseKeys(undefined), []);
  assert.deepEqual(parseKeys(['a', ' b ', 'a']), ['a', 'b']);
});

test('rotation: k1, then k2, then k3, then k1 again, for any number of keys', async () => {
  const f = fake(() => [200, {}]);
  const c = new PandaStackClient({ apiKey: 'k1,k2,k3', fetchImpl: f.fetchImpl, sleep });
  for (let i = 0; i < 4; i++) await c.request('GET', '/v1/ping');
  assert.deepEqual(f.calls.map(authOf), ['Bearer k1', 'Bearer k2', 'Bearer k3', 'Bearer k1']);
  const one = fake(() => [200, {}]);
  const c1 = new PandaStackClient({ apiKey: 'only', fetchImpl: one.fetchImpl });
  await c1.request('GET', '/v1/ping');
  await c1.request('GET', '/v1/ping');
  assert.deepEqual(one.calls.map(authOf), ['Bearer only', 'Bearer only']);
  const seven = fake(() => [200, {}]);
  const c7 = new PandaStackClient({ apiKey: 'a,b,c,d,e,f,g', fetchImpl: seven.fetchImpl });
  for (let i = 0; i < 8; i++) await c7.request('GET', '/v1/ping');
  assert.deepEqual(seven.calls.map(authOf).map((h) => h.slice(7)), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a']);
});

test('a sandbox stays with the key that created it; new sandboxes rotate', async () => {
  let n = 0;
  const f = fake((c) => (c.method === 'POST' && c.url.pathname === '/v1/sandboxes' ? [201, { id: `sb${++n}` }] : c.url.pathname === '/v1/sandboxes' ? [200, []] : [200, { stdout: '', stderr: '', exit_code: 0 }]));
  const { by } = tools({ apiKey: 'a,b,c', fetchImpl: f.fetchImpl, maxActive: 9 });
  const r1: any = await by('sandbox_create').handler({});
  const r2: any = await by('sandbox_create').handler({});
  const posts = f.calls.filter((c) => c.method === 'POST');
  assert.deepEqual(posts.map(authOf), ['Bearer a', 'Bearer b']);
  assert.equal(r1.key_slot, 1);
  assert.equal(r2.key_slot, 2);
  f.calls.length = 0;
  await by('sandbox_exec').handler({ id: 'sb2', cmd: 'ls' });
  await by('sandbox_exec').handler({ id: 'sb1', cmd: 'ls' });
  await by('sandbox_exec').handler({ id: 'sb2', cmd: 'ls' });
  assert.deepEqual(f.calls.map(authOf), ['Bearer b', 'Bearer a', 'Bearer b']);
});

test('a rate-limited or rejected key is skipped, and keys never leak', async () => {
  const f = fake((c) => {
    if (authOf(c) === 'Bearer pds_aaaaaaaa1') return [429, { error: 'rate limited', detail: 'token pds_aaaaaaaa1 is busy' }, { 'retry-after': '30' }];
    return [200, { ok: 1 }];
  });
  const c = new PandaStackClient({ apiKey: 'pds_aaaaaaaa1,pds_bbbbbbbb2', fetchImpl: f.fetchImpl, sleep });
  assert.deepEqual(await c.request('GET', '/v1/ping'), { ok: 1 });
  assert.deepEqual(f.calls.map(authOf), ['Bearer pds_aaaaaaaa1', 'Bearer pds_bbbbbbbb2']);
  await c.request('GET', '/v1/ping');
  await c.request('GET', '/v1/ping');
  assert.ok(f.calls.slice(2).every((x) => authOf(x) === 'Bearer pds_bbbbbbbb2'), 'resting key is tried last');
  assert.equal(c.ring.status()[0].state, 'resting');
  assert.ok(!JSON.stringify(c.ring.status()).includes('pds_'));

  const bad = fake(() => [401, { error: 'unauthorized', detail: 'bad token pds_aaaaaaaa1' }]);
  const c2 = new PandaStackClient({ apiKey: 'pds_aaaaaaaa1,pds_bbbbbbbb2', fetchImpl: bad.fetchImpl });
  await assert.rejects(c2.request('GET', '/v1/ping'), (e: any) => {
    assert.ok(!e.message.includes('pds_aaaaaaaa1') && !e.message.includes('pds_bbbbbbbb2'));
    assert.match(e.message, /tried 2 keys/);
    return true;
  });
  assert.equal(bad.calls.length, 2);
});

test('a 500 is never retried on another key', async () => {
  const f = fake(() => [500, { error: 'boom' }]);
  const c = new PandaStackClient({ apiKey: 'a,b', fetchImpl: f.fetchImpl });
  await assert.rejects(c.request('POST', '/v1/x', { json: {} }), /PandaStack 500/);
  assert.equal(f.calls.length, 1);
});

test('unknown owner: another key answering 404 just means "not this key"', async () => {
  const f = fake((c) => (authOf(c) === 'Bearer a' ? [404, { error: 'not found' }] : [200, { id: 'zzz' }]));
  const c = new PandaStackClient({ apiKey: 'a,b', fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.request('GET', '/v1/sandboxes/zzz', { affinity: 'zzz' }), { id: 'zzz' });
  f.calls.length = 0;
  await c.request('GET', '/v1/sandboxes/zzz', { affinity: 'zzz' });
  assert.deepEqual(f.calls.map(authOf), ['Bearer b'], 'owner remembered');
  await assert.rejects(c.request('GET', '/v1/sandboxes/q', { affinity: 'q', keySlot: 1 }), /404/);
});

test('list tools merge every key and say which key owns each row', async () => {
  const f = fake((c) => [200, { sandboxes: [{ id: authOf(c) === 'Bearer a' ? 'x' : 'y', status: 'running' }] }]);
  const { by } = tools({ apiKey: 'a,b', fetchImpl: f.fetchImpl });
  const r: any = await by('sandbox_list').handler({});
  assert.deepEqual(r.sandboxes.map((s: any) => [s.id, s.key_slot]), [['x', 1], ['y', 2]]);
  const g = fake((c) => (authOf(c) === 'Bearer a' ? [500, { error: 'down' }] : [200, []]));
  const r2: any = await tools({ apiKey: 'a,b', fetchImpl: g.fetchImpl }).by('volume_list').handler({});
  assert.deepEqual(r2.volumes, []);
  assert.equal(r2.errors[0].key_slot, 1);
});

test('the sandbox cap counts every key together, and forks count too', async () => {
  const f = fake((c) => [200, { sandboxes: [{ id: authOf(c) === 'Bearer a' ? 'p' : 'q', status: 'running', metadata: { source: 'lily-mcp' } }, { id: 'kid', status: 'running', metadata: { forked_from: 'p' } }] }]);
  await assert.rejects(tools({ apiKey: 'a,b', fetchImpl: f.fetchImpl, maxActive: 3 }).by('sandbox_create').handler({}), /limit reached \(3\/3/);
  await assert.rejects(tools({ apiKey: 'a', fetchImpl: fake(() => [200, []]).fetchImpl, maxActive: 3 }).by('sandbox_fork').handler({ id: 's', count: 4 }), /limit reached/);
});

test('create from a snapshot boots on the key that owns the snapshot', async () => {
  const f = fake((c) => {
    if (c.url.pathname === '/v1/snapshots') return [200, authOf(c) === 'Bearer b' ? [{ id: 'snap1' }] : []];
    if (c.method === 'POST') return [201, { id: 'new1' }];
    return [200, []];
  });
  const { by } = tools({ apiKey: 'a,b', fetchImpl: f.fetchImpl });
  await by('sandbox_snapshot_list').handler({});
  const r: any = await by('sandbox_create').handler({ from_snapshot: 'snap1', volumes: [{ name: 'data', read_only: true }] });
  const post = f.calls.find((c) => c.method === 'POST')!;
  assert.equal(authOf(post), 'Bearer b');
  assert.deepEqual(JSON.parse(post.body), { ttl_seconds: 900, metadata: { source: 'lily-mcp' }, from_snapshot: 'snap1', volumes: [{ name: 'data', read_only: true }] });
  assert.equal(r.key_slot, 2);
  await assert.rejects(by('sandbox_create').handler({ volumes: [{ name: '../x' }] }), /Invalid volume name/);
});

test('web_search: runs Chromium in a reusable helper sandbox, query only travels as JSON', async () => {
  const hits = { results: [{ title: 'T', url: 'https://example.com/', snippet: 'S' }], engine: 'duckduckgo', errors: [], ok: true };
  const f = fake((c) => {
    if (c.method === 'POST' && c.url.pathname === '/v1/sandboxes') return [201, { id: 'helper1', status: 'running' }];
    if (c.method === 'GET' && c.url.pathname === '/v1/sandboxes') return [200, []];
    if (c.method === 'GET') return [200, { id: 'helper1', status: 'running' }];
    if (c.method === 'PUT') return [200, {}];
    return [200, { stdout: 'log\n' + JSON.stringify(hits), stderr: '', exit_code: 0 }];
  });
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const evil = 'cats"; rm -rf / #$(id)';
  const r: any = await by('web_search').handler({ query: evil, max_results: 99, fetch_pages: 9 });
  assert.equal(r.results[0].url, 'https://example.com/');
  const post = f.calls.find((c) => c.method === 'POST' && c.url.pathname === '/v1/sandboxes')!;
  const sent = JSON.parse(post.body);
  assert.equal(sent.template, 'browser');
  assert.equal(sent.metadata.role, 'web-helper');
  const job = JSON.parse(Buffer.from(f.calls.find((c) => c.method === 'PUT' && String(c.url.searchParams.get('path')).includes('job-'))!.body).toString());
  assert.equal(job.query, evil);
  assert.equal(job.max_results, 10);
  assert.equal(job.fetch_pages, 3);
  const exec = JSON.parse(f.calls.find((c) => c.url.pathname.endsWith('/exec'))!.body);
  assert.ok(!exec.cmd.includes('rm -rf') && !exec.cmd.includes('cats'));
  const before = f.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/sandboxes').length;
  await by('web_search').handler({ query: 'again' });
  assert.equal(f.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/sandboxes').length, before, 'helper reused');
  await assert.rejects(by('web_search').handler({ query: '  ' }), /query is required/);
});

test('web_search spreads helpers over the keys in rotation', async () => {
  let n = 0;
  const f = fake((c) => {
    if (c.method === 'POST' && c.url.pathname === '/v1/sandboxes') return [201, { id: `h${++n}` }];
    if (c.url.pathname === '/v1/sandboxes') return [200, []];
    if (c.method === 'GET') return [200, { status: 'running' }];
    if (c.method === 'PUT') return [200, {}];
    return [200, { stdout: JSON.stringify({ ok: true, engine: 'bing', results: [{ title: 'a', url: 'https://a.test', snippet: '' }], errors: [] }), exit_code: 0 }];
  });
  const { by } = tools({ apiKey: 'a,b,c', fetchImpl: f.fetchImpl, maxActive: 9 });
  for (let i = 0; i < 3; i++) await by('web_search').handler({ query: 'q' + i });
  const creators = f.calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/sandboxes').map(authOf);
  assert.deepEqual(new Set(creators).size, 3, 'one helper per key');
});

test('web_fetch: http(s) only, returns text, title, links', async () => {
  const f = fake((c) => {
    if (c.method === 'POST' && c.url.pathname === '/v1/sandboxes') return [201, { id: 'h' }];
    if (c.url.pathname === '/v1/sandboxes') return [200, []];
    if (c.method === 'PUT') return [200, {}];
    return [200, { stdout: JSON.stringify({ ok: true, status: 200, title: 'Hi', final_url: 'https://e.test/', text: 'x'.repeat(900), links: [{ text: 'a', href: 'https://e.test/a' }] }), exit_code: 0 }];
  });
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const r: any = await by('web_fetch').handler({ url: 'https://e.test', include_links: true, max_chars: 500 });
  assert.equal(r.title, 'Hi');
  assert.equal(r.text.length, 500);
  assert.equal(r.text_truncated_from, 900);
  assert.equal(r.links.length, 1);
  await assert.rejects(by('web_fetch').handler({ url: 'javascript:alert(1)' }), /Only http and https/);
});

test('snapshots, forks, lifecycle, volumes, databases, apps hit the expected endpoints', async () => {
  const f = fake((c) => (c.method === 'DELETE' ? [204, ''] : [200, c.url.pathname === '/v1/sandboxes' ? [] : { id: 'r1' }]));
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const seen = () => f.calls.splice(0).map((c) => `${c.method} ${c.url.pathname}`);
  await by('sandbox_pause').handler({ id: 's1' });
  await by('sandbox_resume').handler({ id: 's1' });
  await by('sandbox_snapshot_create').handler({ id: 's1', name: 'base-1' });
  await by('sandbox_snapshot_delete').handler({ snapshot_id: 'snap1' });
  await by('volume_create').handler({ name: 'data', size_gb: 5 });
  await by('volume_delete').handler({ name: 'data' });
  await by('database_query').handler({ id: 'db1', sql: 'select 1' });
  await by('app_deploy').handler({ id: 'app1' });
  await by('app_logs').handler({ id: 'app1', runtime: true });
  await by('sandbox_remove_port').handler({ id: 's1', port: 3000 });
  assert.deepEqual(seen(), [
    'POST /v1/sandboxes/s1/pause', 'POST /v1/sandboxes/s1/resume', 'POST /v1/sandboxes/s1/snapshots', 'DELETE /v1/snapshots/snap1',
    'POST /v1/volumes', 'DELETE /v1/volumes/data', 'POST /v1/databases/db1/query', 'POST /v1/apps/app1/deploys', 'GET /v1/apps/app1/runtime-logs',
    'DELETE /v1/sandboxes/s1/ports/3000',
  ]);
  await by('sandbox_lifecycle_set').handler({ id: 's1', policy: { ttl_seconds: 999999, idle_timeout_seconds: 60 } });
  assert.equal(JSON.parse(f.calls[0].body).ttl_seconds, 3600);
  assert.equal(f.calls[0].method, 'PATCH');
  await assert.rejects(by('database_query').handler({ id: 'db1', sql: '' }), /sql is required/);
  await assert.rejects(by('volume_get').handler({ name: '../etc' }), /Invalid volume name/);
});

test('pandastack_api: only /v1 paths, never a way around the sandbox limits', async () => {
  const f = fake(() => [200, { ok: true }]);
  const { by } = tools({ fetchImpl: f.fetchImpl });
  for (const bad of ['/etc/passwd', 'https://evil.test/v1/x', '/v1/../admin', '/v1//x', '/v1/x?y=1', '/v1/a b'])
    await assert.rejects(by('pandastack_api').handler({ method: 'GET', path: bad }), /path must start with \/v1\//, bad);
  await assert.rejects(by('pandastack_api').handler({ method: 'POST', path: '/v1/sandboxes', body: {} }), /sandbox_create/);
  await assert.rejects(by('pandastack_api').handler({ method: 'POST', path: '/v1/sandboxes/a/fork' }), /sandbox_fork/);
  await assert.rejects(by('pandastack_api').handler({ method: 'TRACE', path: '/v1/x' }), /method must be/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await by('pandastack_api').handler({ method: 'GET', path: '/v1/usage', query: { days: 7, junk: { a: 1 } } }), { ok: true });
  assert.equal(f.calls[0].url.searchParams.get('days'), '7');
  assert.equal(f.calls[0].url.searchParams.get('junk'), null);
});

test('pandastack_status shows slots and limits, never keys', async () => {
  const f = fake((c) => (c.url.pathname === '/healthz' ? [200, { status: 'ok' }] : [404, { error: 'nope' }]));
  const r: any = await tools({ apiKey: 'pds_secret_one,pds_secret_two', fetchImpl: f.fetchImpl }).by('pandastack_status').handler({});
  assert.equal(r.keys, 2);
  assert.equal(r.rotation.length, 2);
  assert.deepEqual(r.health, { status: 'ok' });
  assert.ok(r.version.error);
  assert.ok(!JSON.stringify(r).includes('pds_secret'));
  assert.equal(f.calls.every((c) => c.headers.Authorization === undefined), true, 'health probes need no key');
});

test('core toolset is the default: everyday tools plus pandastack_api, a fraction of the full set', () => {
  const core = buildSandboxTools({ apiKey: 'k' });
  const full = buildSandboxTools({ apiKey: 'k', toolset: 'full' });
  const names = core.map((t) => t.name);
  for (const n of ['sandbox_create', 'sandbox_exec', 'sandbox_browser_screenshot', 'web_fetch', 'web_search', 'pandastack_api', 'sandbox_delete']) assert.ok(names.includes(n), n);
  for (const n of ['sandbox_snapshot_create', 'sandbox_fork', 'volume_create', 'database_query', 'app_deploy']) assert.ok(!names.includes(n), `${n} stays out of core`);
  assert.ok(core.length <= 16 && full.length >= 50, `${core.length} core vs ${full.length} full`);
  assert.ok(JSON.stringify(core).length < JSON.stringify(full).length / 2);
  assert.equal(sandboxOptionsFromEnv({ PANDASTACK_API_KEY: 'k' } as any).toolset, 'core');
  assert.equal(sandboxOptionsFromEnv({ PANDASTACK_API_KEY: 'k', SANDBOX_TOOLSET: 'FULL' } as any).toolset, 'full');
  for (const t of core) assert.ok(SANDBOX_ANNOTATIONS[t.name], `${t.name} annotated`);
});

test('core mode keeps everything reachable: pandastack_api can call any /v1 endpoint', async () => {
  const f = fake(() => [200, [{ name: 'data' }]]);
  const t = buildSandboxTools({ apiKey: 'k', fetchImpl: f.fetchImpl, sleep });
  const api = t.find((x) => x.name === 'pandastack_api')!;
  await api.handler({ method: 'GET', path: '/v1/volumes' });
  assert.equal(f.calls[0].url.pathname, '/v1/volumes');
});
