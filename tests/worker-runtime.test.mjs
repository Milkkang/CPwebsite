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

test('real Workers auth runtime encrypts sessions and serves protected callback HTML',async()=>{
 const origin='https://tfrfkvkjmaqnpxdhxumr.supabase.co';
 const user='55555555-5555-4555-8555-555555555555',session='66666666-6666-4666-8666-666666666666';
 const token='fake.'+Buffer.from(JSON.stringify({sub:user,session_id:session,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.signature';
 let stored,assetPath;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile('.cloudflare/output/v1/workers/default/bundle/index.js','utf8'),compatibilityDate:'2026-11-17',
  bindings:{SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture'},
  serviceBindings:{ASSETS:async request=>{assetPath=new URL(request.url).pathname;if(assetPath!=='/')return new RuntimeResponse(null,{status:307,headers:{location:'/'}});return new RuntimeResponse('<html><body>Callback</body></html>',{headers:{'content-type':'text/html'}});}},
  outboundService:async request=>{
   const path=new URL(request.url).pathname;
   assert.equal(new URL(request.url).origin,origin);
   if(path.endsWith('/consume_auth_limit'))return new RuntimeResponse('true',{headers:{'content-type':'application/json'}});
   if(path==='/auth/v1/token')return new RuntimeResponse(JSON.stringify({access_token:token}),{headers:{'content-type':'application/json'}});
   if(path==='/auth/v1/user')return new RuntimeResponse(JSON.stringify({id:user,email:'fixture@example.invalid',email_confirmed_at:new Date().toISOString()}),{headers:{'content-type':'application/json'}});
   if(path==='/rest/v1/buyer_profiles')return new RuntimeResponse('[]',{headers:{'content-type':'application/json'}});
   if(path==='/rest/v1/server_sessions'){stored=await request.json();return new RuntimeResponse('[]',{headers:{'content-type':'application/json'}});}
   throw Error('Unexpected request');
  }
 }));
 try{
  const r=await mf.dispatchFetch('https://cpvaluemart.com/api/auth/login',{method:'POST',headers:{origin:'https://cpvaluemart.com','content-type':'application/json'},body:JSON.stringify({email:'fixture@example.invalid',password:'fixture-password'})});
  assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('HttpOnly; Secure; SameSite=Lax'));
  assert.notEqual(stored.access_token_encrypted,token);assert.equal(stored.session_hash.length,64);
  const callback=await mf.dispatchFetch('https://cpvaluemart.com/auth/reset?token_hash=fixture&type=recovery');
  assert.equal(callback.status,200);assert.equal(assetPath,'/');assert.equal(callback.headers.get('referrer-policy'),'no-referrer');assert.ok(callback.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
 }finally{await mf.dispose();}
});
