import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = '.cloudflare/output/v1/workers/default/';
for (const name of await readdir('dist')) {
  assert.deepEqual(await readFile(root + 'assets/' + name), await readFile('dist/' + name), `Storefront changed during build: ${name}`);
}
const config = JSON.parse(await readFile(root + 'worker.config.json', 'utf8'));
assert.equal(config.name, 'cpwebsite');
assert.equal(config.env.ASSETS.type, 'assets');
assert.deepEqual(config.assets.runWorkerFirst, ['/api', '/api/*', '/auth/confirm', '/auth/reset']);
assert.equal(config.observability.redactQueryString, true);
console.log('PASS: storefront asset bytes, Worker target, asset binding and API routing');
