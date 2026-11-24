import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { catalogParameters } from '../src/catalog-api.mjs';
const env = { SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test', SUPABASE_SECRET_KEY:'do-not-use-service-secret' };
const call = (path,method='GET',bindings=env) => worker.fetch(new Request('https://cpvaluemart.com'+path,{method}),bindings);
async function withFetch(fn, run) { const original=globalThis.fetch;globalThis.fetch=fn;try { await run(); } finally {globalThis.fetch=original;} }

test('catalog accepts bounded filters with literal search, rejects malformed or injected controls', () => {
  assert.deepEqual(catalogParameters(new URLSearchParams('q=Oral-B&category=oral-care&brand=Oral-B&sort=price-up&size=50&page=2')),
    {p_query:'Oral-B',p_category:'oral-care',p_brand:'Oral-B',p_sort:'price-up',p_size:50,p_page:2});
  for(const params of ['size=1000','page=-1','page=0','page=1.5','page=1000001','size=30&size=50','sort=sql','status=Draft','q='+ 'x'.repeat(121)])
    assert.throws(()=>catalogParameters(new URLSearchParams(params)));
});

test('one read-only RPC per listing request uses only publishable privileges', async () => {
  await withFetch(async(url,options)=>{
    assert.equal(url,env.SUPABASE_URL+'/rest/v1/rpc/read_catalog');
    assert.equal(options.headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(JSON.stringify(options).includes(env.SUPABASE_SECRET_KEY),false);
    assert.equal(options.redirect,'manual');
    assert.equal(JSON.parse(options.body).p_query,'(name.eq.secret),status.eq.Draft');
    return Response.json({products:[],pagination:{total:0,totalPages:1,page:1,pageSize:30}});
  },async()=>{
    const response=await call('/api/products?q='+encodeURIComponent('(name.eq.secret),status.eq.Draft'));
    assert.equal(response.status,200);assert.deepEqual((await response.json()).products,[]);
  });
});

test('API denies mutation, invalid inputs and unknown SKU without HTML fallback', async () => {
  await withFetch(async()=>Response.json([]),async()=>{
    assert.equal((await call('/api/products','POST')).status,405);
    assert.equal((await call('/api/products?size=500')).status,400);
    assert.equal((await call('/api/products/unknown')).status,404);
    assert.equal((await call('/api/products/a%22or')).status,400);
    assert.equal((await call('/api/categories?select=admin_roles')).status,400);
  });
});

test('product detail resolves options through a published-only lookup by the group SKU', async () => {
  const product={sku:'SOAP-500',variant_name:'500g',variant_of:'SOAP-250'};
  const options=[{sku:'SOAP-250',variant_name:'250g'},{sku:product.sku,variant_name:product.variant_name}];
  await withFetch(async (url,{headers})=>{
    const params=new URL(url).searchParams;
    assert.equal(headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(params.get('status'),'eq.Published');
    if(params.get('sku')==='eq.SOAP-500')return Response.json([product]);
    assert.equal(params.get('or'),'(sku.eq.SOAP-250,variant_of.eq.SOAP-250)');
    return Response.json(options);
  },async()=>{
    const response=await call('/api/products/SOAP-500');
    assert.equal(response.status,200);
    const {product:listed,options:choices}=await response.json();
    assert.deepEqual(listed,{sku:product.sku,variant_name:product.variant_name});
    assert.deepEqual(choices,options);
  });
});

test('database outage and absent configuration fail closed without leaking upstream secrets', async () => {
  await withFetch(async()=>new Response('private-error '+env.SUPABASE_SECRET_KEY,{status:500}),async()=>{
    const response=await call('/api/products');assert.equal(response.status,503);
    const body=await response.text();assert.equal(body.includes('private-error'),false);assert.equal(body.includes(env.SUPABASE_SECRET_KEY),false);
    assert.equal((await call('/api/products','GET',{})).status,503);
  });
});

test('public config never requests coupons or roles and HEAD has no body', async()=>{
  const paths=[];
  await withFetch(async url=>{paths.push(url);return Response.json([]);},async()=>{
    const response=await call('/api/config');assert.equal(response.status,200);
    assert.deepEqual((await response.json()).delivery,[]);
    assert.equal(await(await call('/api/categories','HEAD')).text(),'');
  });
  assert.equal(paths.length,3);
  assert.equal(paths.some(p=>p.includes('coupons')||p.includes('admin_roles')),false);
});

test('brands are filtered through the published facet RPC and active offers expose only coupon terms',async()=>{
 const paths=[];
 await withFetch(async(url,options)=>{paths.push([url,options]);return Response.json(url.includes('read_catalog_brands')?['Acme']:[]);},async()=>{
  const brands=await call('/api/brands?q=soap&category=skin-care');
  assert.equal(brands.status,200);assert.deepEqual((await brands.json()).brands,['Acme']);
  assert.equal((await call('/api/brands?status=Draft')).status,400);
  const offers=await call('/api/offers');assert.equal(offers.status,200);
  assert.deepEqual((await offers.json()).offers,[]);
 });
 assert.equal(JSON.parse(paths[0][1].body).p_query,'soap');
 assert.equal(paths[0][1].headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
 assert.equal(paths[1][1].headers.apikey,env.SUPABASE_SECRET_KEY);
 assert.equal(paths[1][0].includes('active=eq.true'),true);
});
