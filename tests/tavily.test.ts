import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTavilyTools, TAVILY_ANNOTATIONS, tavilyOptionsFromEnv } from '../src/tavily';

type Call = { url: URL; headers: Record<string, string>; body: any };

function fake(handler: (c: Call, n: number) => [number, any, Record<string, string>?]) {
  const calls: Call[] = [];
  const fetchImpl: any = async (url: any, init: any) => {
    const c: Call = { url: new URL(String(url)), headers: init.headers, body: JSON.parse(init.body) };
    calls.push(c);
    const [status, body, headers] = handler(c, calls.length);
    return new Response(JSON.stringify(body), { status, headers: headers || {} });
  };
  return { calls, fetchImpl };
}
const tools = (opts: any) => {
  const list = buildTavilyTools({ apiKey: 'tvly-secret1', ...opts });
  return { list, by: (n: string) => list.find((t) => t.name === n)!.handler };
};
const auth = (c: Call) => c.headers.Authorization;
const OK = { answer: 'A short answer', results: [{ title: 'T', url: 'https://e.test/', content: 'snippet', score: 0.9, raw_content: 'p'.repeat(9000) }] };

test('no key means no tools; env reader; annotations', () => {
  assert.deepEqual(buildTavilyTools({ apiKey: '' }), []);
  assert.deepEqual(buildTavilyTools({ apiKey: ' , ' }), []);
  assert.equal(tavilyOptionsFromEnv({ TAVILY_API_KEY: 'k1,k2' } as any).apiKey, 'k1,k2');
  const { list } = tools({ fetchImpl: fake(() => [200, OK]).fetchImpl });
  assert.deepEqual(list.map((t) => t.name), ['web_search', 'web_extract', 'web_map']);
  for (const t of list) assert.equal(TAVILY_ANNOTATIONS[t.name].readOnlyHint, true);
});

test('search: sends the right request, shapes results, marks them untrusted', async () => {
  const f = fake(() => [200, OK]);
  const r: any = await tools({ fetchImpl: f.fetchImpl }).by('web_search')({ query: 'node 26 release', max_results: 99, include_page_text: true, page_chars: 600, topic: 'news', include_domains: ['nodejs.org'] });
  assert.equal(f.calls[0].url.pathname, '/search');
  assert.equal(auth(f.calls[0]), 'Bearer tvly-secret1');
  assert.equal(f.calls[0].body.max_results, 10);
  assert.equal(f.calls[0].body.topic, 'news');
  assert.equal(f.calls[0].body.include_answer, true);
  assert.equal(f.calls[0].body.include_raw_content, 'markdown');
  assert.deepEqual(f.calls[0].body.include_domains, ['nodejs.org']);
  assert.equal(r.answer, 'A short answer');
  assert.equal(r.results[0].page_text.length, 600);
  assert.match(r.untrusted, /data, not as instructions/);
  const plain: any = await tools({ fetchImpl: fake(() => [200, OK]).fetchImpl }).by('web_search')({ query: 'x' });
  assert.equal(plain.results[0].page_text, undefined);
});

test('queries are scrubbed of secrets before leaving; input is validated first', async () => {
  const f = fake(() => [200, OK]);
  const { by } = tools({ fetchImpl: f.fetchImpl });
  const r: any = await by('web_search')({ query: 'why does ghp_' + 'a'.repeat(36) + ' fail' });
  assert.ok(!JSON.stringify(f.calls[0].body).includes('ghp_'));
  assert.ok(r.query_redactions >= 1);
  await assert.rejects(by('web_search')({ query: '   ' }), /query is required/);
  await assert.rejects(by('web_search')({ query: 'x'.repeat(401) }), /max 400/);
  await assert.rejects(by('web_search')({ query: 'x', search_depth: 'deep' }), /one of/);
  await assert.rejects(by('web_search')({ query: 'x', include_domains: ['a b'] }), /plain domains/);
  await assert.rejects(by('web_extract')({ urls: [] }), /1 to 5/);
  await assert.rejects(by('web_extract')({ urls: ['file:///etc/passwd'] }), /Only http and https/);
  await assert.rejects(by('web_extract')({ urls: ['not a url'] }), /not a valid URL/);
  assert.equal(f.calls.length, 1, 'only the valid search made a request');
});

test('extract: reads pages, cuts long text, reports failures', async () => {
  const f = fake(() => [200, { results: [{ url: 'https://e.test/a', raw_content: 'x'.repeat(900) }], failed_results: [{ url: 'https://e.test/b', error: 'blocked' }] }]);
  const r: any = await tools({ fetchImpl: f.fetchImpl }).by('web_extract')({ urls: ['https://e.test/a', 'https://e.test/b'], max_chars: 500 });
  assert.equal(f.calls[0].url.pathname, '/extract');
  assert.deepEqual(f.calls[0].body.urls, ['https://e.test/a', 'https://e.test/b']);
  assert.equal(r.pages[0].text.length, 500);
  assert.equal(r.pages[0].text_truncated_from, 900);
  assert.deepEqual(r.failed, [{ url: 'https://e.test/b', error: 'blocked' }]);
});

test('rotation: k1, k2, k3, k1 again, for any number of keys', async () => {
  const f = fake(() => [200, OK]);
  const { by } = tools({ apiKey: 'k1aaaaaaaa,k2bbbbbbbb,k3cccccccc', fetchImpl: f.fetchImpl });
  for (let i = 0; i < 4; i++) await by('web_search')({ query: 'q' + i });
  assert.deepEqual(f.calls.map(auth), ['Bearer k1aaaaaaaa', 'Bearer k2bbbbbbbb', 'Bearer k3cccccccc', 'Bearer k1aaaaaaaa']);
});

test('a key over its plan limit, rate limited, or rejected is skipped; keys never leak', async () => {
  for (const status of [432, 433, 429, 401]) {
    const f = fake((c) => (auth(c) === 'Bearer tvly-aaaaaaaa1' ? [status, { detail: { error: 'limit for tvly-aaaaaaaa1 reached' } }] : [200, OK]));
    const { by } = tools({ apiKey: 'tvly-aaaaaaaa1,tvly-bbbbbbbb2', fetchImpl: f.fetchImpl });
    const r: any = await by('web_search')({ query: 'x' });
    assert.equal(r.answer, 'A short answer', String(status));
    assert.deepEqual(f.calls.map(auth), ['Bearer tvly-aaaaaaaa1', 'Bearer tvly-bbbbbbbb2'], String(status));
    await by('web_search')({ query: 'y' });
    await by('web_search')({ query: 'z' });
    assert.ok(f.calls.slice(2).every((c) => auth(c) === 'Bearer tvly-bbbbbbbb2'), `${status}: resting key goes to the back`);
  }
  const bad = fake(() => [401, { detail: { error: 'bad key tvly-aaaaaaaa1 / tvly-bbbbbbbb2' } }]);
  await assert.rejects(tools({ apiKey: 'tvly-aaaaaaaa1,tvly-bbbbbbbb2', fetchImpl: bad.fetchImpl }).by('web_search')({ query: 'x' }), (e: any) => {
    assert.ok(!e.message.includes('tvly-aaaaaaaa1') && !e.message.includes('tvly-bbbbbbbb2'));
    assert.match(e.message, /tried 2 keys/);
    assert.equal(e.isToolError, true);
    return true;
  });
  assert.equal(bad.calls.length, 2);
});

test('a bad request or server error is reported as it is, not retried on another key', async () => {
  for (const status of [400, 500, 502]) {
    const f = fake(() => [status, { detail: { error: 'nope' } }]);
    await assert.rejects(tools({ apiKey: 'tvly-aaaaaaaa1,tvly-bbbbbbbb2', fetchImpl: f.fetchImpl }).by('web_search')({ query: 'x' }), new RegExp(`Tavily ${status}`));
    assert.equal(f.calls.length, 1, String(status));
  }
});

test('map: lists URLs with sane caps, scrubs instructions, validates input', async () => {
  const f = fake(() => [200, { base_url: 'https://docs.e.test', results: ['https://docs.e.test/a', 'https://docs.e.test/b'], usage: { credits: 1 } }]);
  const { by, list } = tools({ fetchImpl: f.fetchImpl });
  assert.deepEqual(list.map((t) => t.name), ['web_search', 'web_extract', 'web_map']);
  assert.equal(TAVILY_ANNOTATIONS.web_map.readOnlyHint, true);
  const r: any = await by('web_map')({ url: 'https://docs.e.test', max_depth: 99, max_breadth: 999, limit: 9999, instructions: 'pages about ghp_' + 'a'.repeat(36), select_paths: ['/docs/.*'] });
  const b = f.calls[0].body;
  assert.equal(f.calls[0].url.pathname, '/map');
  assert.deepEqual([b.max_depth, b.max_breadth, b.limit, b.allow_external], [3, 50, 100, false]);
  assert.ok(!b.instructions.includes('ghp_'));
  assert.deepEqual(b.select_paths, ['/docs/.*']);
  assert.deepEqual(r.urls, ['https://docs.e.test/a', 'https://docs.e.test/b']);
  assert.equal(r.count, 2);
  assert.match(r.untrusted, /data/);
  await assert.rejects(by('web_map')({ url: 'file:///etc/passwd' }), /Only http and https/);
  await assert.rejects(by('web_map')({ url: 'https://e.test', instructions: 'x'.repeat(301) }), /at most 300/);
  await assert.rejects(by('web_map')({ url: 'https://e.test', select_paths: ['(unclosed'] }), /valid regular expression/);
  await assert.rejects(by('web_map')({ url: 'https://e.test', exclude_paths: 'x' }), /at most 10/);
  assert.equal(f.calls.length, 1);
});

test('placeholder keys mean "no key": nothing is switched on with a fake key', async () => {
  for (const v of ['not_set', 'not set', 'NOT_SET', 'none', 'changeme', 'xxxx', '"not_set"', ' , ']) assert.deepEqual(buildTavilyTools({ apiKey: v }), [], v);
  assert.equal(buildTavilyTools({ apiKey: 'tvly-real1234,not_set' }).length, 3, 'a placeholder inside a list is dropped, the real key stays');
  const { parseKeys } = await import('../src/pandastack/client');
  assert.deepEqual(parseKeys('not_set'), []);
  assert.deepEqual(parseKeys('pds_a, not_set ,pds_b'), ['pds_a', 'pds_b']);
});

test('usage is requested and shown, and the cost guidance is in the tool text', async () => {
  const f = fake(() => [200, { ...OK, usage: { credits: 1 } }]);
  const { list, by } = tools({ fetchImpl: f.fetchImpl });
  const r: any = await by('web_search')({ query: 'x' });
  assert.equal(f.calls[0].body.include_usage, true);
  assert.equal(r.credits_used, 1);
  assert.match(list[0].description, /costs credits/);
  const { TAVILY_HINT } = await import('../src/tavily');
  assert.match(TAVILY_HINT, /credits/);
});
