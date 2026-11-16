import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiKeys, authenticateApiKey } from '../src/apikeys';

const A = 'a'.repeat(40);
const B = 'b'.repeat(32);

test('parses label=secret and label:read=secret; default scope is full', () => {
  const { keys, warnings } = parseApiKeys(`terminal=${A}, viewer:read=${B}`);
  assert.deepEqual(keys.map((k) => [k.label, k.scope]), [['terminal', 'full'], ['viewer', 'read']]);
  assert.deepEqual(warnings, []);
});

test('placeholders mean no key; short, malformed, duplicate and bad-scope entries are refused with a warning', () => {
  assert.deepEqual(parseApiKeys('x=not_set').keys, []);
  assert.deepEqual(parseApiKeys('x=not_set').warnings, []);
  assert.deepEqual(parseApiKeys(undefined).keys, []);
  const r = parseApiKeys(`short=abc, nolabel, bad scope:admin=${A}, ok=${A}, ok=${B}, we!rd=${A}`);
  assert.deepEqual(r.keys.map((k) => k.label), ['ok']);
  assert.equal(r.warnings.length, 5);
  assert.ok(!r.warnings.join(' ').includes(A), 'warnings never contain a secret');
});

test('authenticate matches the exact secret only, and returns that key', () => {
  const { keys } = parseApiKeys(`one=${A}, two:read=${B}`);
  assert.equal(authenticateApiKey(A, keys)?.label, 'one');
  assert.equal(authenticateApiKey(B, keys)?.scope, 'read');
  assert.equal(authenticateApiKey(A + 'x', keys), null);
  assert.equal(authenticateApiKey(A.slice(1), keys), null);
  assert.equal(authenticateApiKey('', keys), null);
  assert.equal(authenticateApiKey(A, []), null);
});
