import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import miniflare from 'miniflare';
const { Miniflare, Response: RuntimeResponse, convertV4MiniflareOptions } = miniflare;

test('real Workers runtime can read Supabase and refuses upstream redirects', async () => {
  const origin='https://tfrfkvkjmaqnpxdhxumr.supabase.co';
  const calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,
    script:await readFile('.cloudflare/output/v1/workers/default/bundle/index.js','utf8'),compatibilityDate:'2026-11-17',
    bindings:{SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_runtime_fixture'},
    outboundService: async request => {
      const url=new URL(request.url);calls.push(url.origin+url.pathname);
      assert.equal(url.origin,origin);
      assert.equal(request.headers.get('apikey'),'sb_publishable_runtime_fixture');
      if(url.pathname==='/rest/v1/rpc/read_catalog') return new RuntimeResponse(JSON.stringify({products:[],pagination:{total:0,page:1,pageSize:30,totalPages:1}}),{headers:{'content-type':'application/json'}});
      if(url.pathname==='/rest/v1/categories') return new RuntimeResponse('',{status:302,headers:{location:'https://not-allowed.example/steal'}});
      throw Error('Unexpected outbound request');
    }
  }));
  try {
    const response=await mf.dispatchFetch('https://cpvaluemart.com/api/products');
    assert.equal(response.status,200);assert.equal((await response.json()).pagination.total,0);
    const redirected=await mf.dispatchFetch('https://cpvaluemart.com/api/categories');
    assert.equal(redirected.status,503);assert.equal((await redirected.json()).error.code,'CATALOG_UNAVAILABLE');
    assert.deepEqual(calls,[origin+'/rest/v1/rpc/read_catalog',origin+'/rest/v1/categories']);
  } finally { await mf.dispose(); }
});
