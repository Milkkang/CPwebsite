// Phase 2 baseline acceptance only; later intentional catalog edits should change the expectations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const { seed } = await import('../scripts/migration/catalog-source.mjs');
const base='https://cpvaluemart.com';
async function get(path,status=200,method='GET') {
 const r=await fetch(base+path,{method,headers:{'User-Agent':'Mozilla/5.0 CPValueMartAcceptance'},signal:AbortSignal.timeout(15000)});
 assert.equal(r.status,status,path);assert.ok(r.headers.get('content-type').includes('application/json'));assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(r.headers.get('x-request-id'));
 return method==='HEAD'?null:r.json();
}
const h=await get('/api/health');assert.equal(h.phase,2);
for(const size of [30,50,100]) {const d=await get('/api/products?size='+size);assert.equal(d.products.length,size);assert.equal(d.pagination.total,678);assert.equal(d.pagination.pageSize,size);}
const all=[];
for(let page=1;page<=7;page++) all.push(...(await get('/api/products?size=100&page='+page)).products);
assert.equal(all.length,678);assert.equal(new Set(all.map(p=>p.sku)).size,678);
const map=new Map(all.map(p=>[p.sku,p]));
for(const expected of seed.products) {const actual=map.get(expected.sku);assert.ok(actual,expected.sku);for(const k of Object.keys(expected))assert.deepEqual(actual[k],expected[k],expected.sku+':'+k);assert.equal(actual.currency,'SGD');}
let d=await get('/api/products?category=personal-care&size=100');assert.equal(d.pagination.total,298);assert.ok(d.products.every(p=>p.category_id==='personal-care'));
d=await get('/api/products?q=13M-01-01');assert.equal(d.pagination.total,1);
d=await get('/api/products?brand=Oral-B');assert.ok(d.products.length);assert.ok(d.products.every(p=>p.brand==='Oral-B'));
for(const sort of ['price-up','price-down','name']) {
 d=await get('/api/products?sort='+sort+'&size=100');
 if(sort!=='name')assert.ok(d.products.every((p,i)=>i===0||(sort==='price-up'?d.products[i-1].price_cents<=p.price_cents:d.products[i-1].price_cents>=p.price_cents)));
 else assert.equal(d.products.length,100);
}
d=await get('/api/products?page=999999&size=100');assert.equal(d.pagination.page,7);assert.equal(d.products.length,78);
d=await get('/api/products?q=does-not-exist-0000000');assert.equal(d.pagination.total,0);assert.equal(d.pagination.totalPages,1);
d=await get('/api/products/13M-01-01');assert.equal(d.product.price_cents,449);
assert.equal((await get('/api/categories')).categories.length,11);
d=await get('/api/config');assert.equal(d.homepage.title,seed.homepage.title);assert.equal(d.delivery[0].shipping_cents,390);assert.equal(d.delivery[0].free_threshold_cents,5000);assert.equal('coupons' in d,false);
for(const path of ['/api/products?size=500','/api/products?status=Draft','/api/products?page=-1','/api/products?size=30&size=50']) await get(path,400);
await get('/api/products/no-such-sku',404);await get('/api/products',405,'POST');await get('/api/products',200,'HEAD');
const home=await(await fetch(base+'/')).arrayBuffer();assert.equal(createHash('sha256').update(new Uint8Array(home)).digest('hex'),createHash('sha256').update(await readFile(new URL('../dist/index.html',import.meta.url))).digest('hex'));
console.log('PASS: live 678 SKU exact-field comparison; 30/50/100, all 7 pages without duplication, categories/brand/search/sort, boundary pages, public config, 400/404/405/HEAD, request IDs/no-store, storefront unchanged');
