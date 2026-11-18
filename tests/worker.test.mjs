import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const env = { ASSETS: { fetch: async () => new Response('storefront', { status: 200, headers: { 'X-Asset': 'preserved' } }) }, SECRET: 'never-expose-this' };
const call = (path, method = 'GET') => worker.fetch(new Request('https://cpvaluemart.com' + path, { method }), env);

test('health returns public metadata and a fresh request ID without caching', async () => {
  const response = await call('/api/health');
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.requestId, response.headers.get('x-request-id'));
  assert.notEqual(data.requestId, (await (await call('/api/health')).json()).requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(data).includes(env.SECRET), false);
});

test('API misses and disallowed methods cannot fall through to HTML', async () => {
  for (const path of ['/api', '/api/no-such-endpoint', '/api/health/']) {
    const response = await call(path);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
  const response = await call('/api/health', 'POST');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(await (await call('/api/health', 'HEAD')).text(), '');
});

test('storefront paths and assets are passed through unchanged', async () => {
  for (const path of ['/', '/app.js', '/apiary', '/missing-page']) {
    const response = await call(path);
    assert.equal(response.headers.get('x-asset'), 'preserved');
    assert.equal(await response.text(), 'storefront');
  }
});

test('logs exclude query strings, private path segments, tokens and headers', async () => {
  const logs = [];
  const original = console.log;
  console.log = value => logs.push(value);
  try { await call('/api/private-email@example.com?token=secret-query'); }
  finally { console.log = original; }
  const serialized = logs.join('');
  for (const sensitive of ['private-email', 'secret-query', env.SECRET]) assert.equal(serialized.includes(sensitive), false);
  const record = JSON.parse(logs[0]);
  assert.equal(record.route, 'unmatched-api');
  assert.equal(record.status, 404);
});
