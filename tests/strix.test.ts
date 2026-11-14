import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStrixTools, STRIX_ANNOTATIONS, strixOptionsFromEnv } from '../src/strix';

type Call = { url: URL; headers: Record<string, string>; body: any };

function fake(handler: (c: Call, n: number) => [number, any]) {
  const calls: Call[] = [];
  const fetchImpl: any = async (url: any, init: any) => {
    const c: Call = { url: new URL(String(url)), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const [status, body] = handler(c, calls.length);
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}
const tools = (opts: any) => {
  const list = buildStrixTools({ apiKey: 'strix-secret1', ...opts });
  return { list, by: (n: string) => list.find((t) => t.name === n)!.handler };
};
const auth = (c: Call) => c.headers.Authorization;

test('no token means no tools; env reader; annotations', () => {
  assert.deepEqual(buildStrixTools({ apiKey: '' }), []);
  assert.deepEqual(buildStrixTools({ apiKey: ' , ' }), []);
  assert.equal(strixOptionsFromEnv({ STRIX_API_TOKEN: 'k1,k2' } as any).apiKey, 'k1,k2');
  const { list } = tools({ fetchImpl: fake(() => [200, { id: 's1' }]).fetchImpl });
  assert.deepEqual(list.map((t) => t.name), ['strix_api']);
  assert.equal(STRIX_ANNOTATIONS.strix_api.openWorldHint, true);
});

test('sends method/path/body to the right URL with a bearer token', async () => {
  const f = fake(() => [200, { scan_id: 'abc', status: 'queued' }]);
  const r: any = await tools({ fetchImpl: f.fetchImpl }).by('strix_api')({ method: 'post', path: '/scans', body: { domain_ids: ['d1'] } });
  assert.equal(f.calls[0].url.pathname, '/api/v1/scans');
  assert.equal(auth(f.calls[0]), 'Bearer strix-secret1');
  assert.deepEqual(f.calls[0].body, { domain_ids: ['d1'] });
  assert.equal(r.scan_id, 'abc');
});

test('input is validated before any request is made', async () => {
  const f = fake(() => [200, {}]);
  const { by } = tools({ fetchImpl: f.fetchImpl });
  await assert.rejects(by('strix_api')({ method: 'FETCH', path: '/scans' }), /method must be one of/);
  await assert.rejects(by('strix_api')({ method: 'GET', path: 'scans' }), /must start with \//);
  await assert.rejects(by('strix_api')({ method: 'POST', path: '/scans', body: ['nope'] }), /body must be a JSON object/);
  assert.equal(f.calls.length, 0);
});

test('a 401/403 rests a token and tries the next one; errors never leak tokens', async () => {
  const f = fake((c) => (auth(c) === 'Bearer strix-aaaaaaaa1' ? [401, { detail: 'bad token strix-aaaaaaaa1' }] : [200, { ok: true }]));
  const { by } = tools({ apiKey: 'strix-aaaaaaaa1,strix-bbbbbbbb2', fetchImpl: f.fetchImpl });
  const r: any = await by('strix_api')({ method: 'GET', path: '/scans' });
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map(auth), ['Bearer strix-aaaaaaaa1', 'Bearer strix-bbbbbbbb2']);

  const bad = fake(() => [401, { detail: 'bad token strix-aaaaaaaa1 / strix-bbbbbbbb2' }]);
  await assert.rejects(tools({ apiKey: 'strix-aaaaaaaa1,strix-bbbbbbbb2', fetchImpl: bad.fetchImpl }).by('strix_api')({ method: 'GET', path: '/scans' }), (e: any) => {
    assert.ok(!e.message.includes('strix-aaaaaaaa1') && !e.message.includes('strix-bbbbbbbb2'));
    assert.match(e.message, /tried 2 tokens/);
    assert.equal(e.isToolError, true);
    return true;
  });
});

test('a bad request or server error is reported as it is, not retried on another token', async () => {
  for (const status of [400, 404, 500]) {
    const f = fake(() => [status, { detail: 'nope' }]);
    await assert.rejects(tools({ apiKey: 'strix-aaaaaaaa1,strix-bbbbbbbb2', fetchImpl: f.fetchImpl }).by('strix_api')({ method: 'GET', path: '/scans' }), new RegExp(`Strix ${status}`));
    assert.equal(f.calls.length, 1, String(status));
  }
});
