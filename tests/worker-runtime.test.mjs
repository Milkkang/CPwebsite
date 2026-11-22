import { test } from 'node:test';
import { createHash } from 'node:crypto';
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

test('real Workers checkout creates test sessions and rejects provider redirects without following them',async()=>{
 const origin='https://tfrfkvkjmaqnpxdhxumr.supabase.co';
 const user='11111111-1111-4111-8111-111111111111',order='99999999-9999-4999-8999-999999999999';
 let redirect=false,stripeCalls=0,releases=0;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,
  script:await readFile('.cloudflare/output/v1/workers/default/bundle/index.js','utf8'),compatibilityDate:'2026-11-17',
  bindings:{SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'runtime@example.invalid'},
  outboundService:async request=>{
   const url=new URL(request.url);const json=data=>new RuntimeResponse(JSON.stringify(data),{headers:{'content-type':'application/json'}});
   if(url.origin==='https://api.stripe.com'){
    assert.equal(url.pathname,'/v1/checkout/sessions');stripeCalls++;
    const form=new URLSearchParams(await request.text());assert.equal(form.get('line_items[0][price_data][unit_amount]'),'100');
    return redirect?new RuntimeResponse(null,{status:302,headers:{location:'https://never-follow.example/secret'}}):json({id:'cs_test_runtime',url:'https://checkout.stripe.com/c/pay/cs_test_runtime',livemode:false});
   }
   assert.equal(url.origin,origin,'must never forward authorization to a redirect target');
   if(url.pathname.endsWith('resolve_web_session'))return json({account:{id:user,email:'runtime@example.invalid',verified:true},isAdmin:false});
   if(url.pathname.endsWith('create_test_order'))return json({id:order,number:'CVM-RUNTIME',total_cents:100,items:[]});
   if(url.pathname.endsWith('attach_test_checkout'))return json(true);
   if(url.pathname.endsWith('release_test_order')){releases++;return json(true);}
   throw Error('Unexpected runtime fixture route');
  }
 }));
 try{
  const call=()=>mf.dispatchFetch('https://cpvaluemart.com/api/checkout/session',{method:'POST',headers:{Origin:'https://cpvaluemart.com',Cookie:'__Host-cvm-session='+'a'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify({addressId:'88888888-8888-4888-8888-888888888888'})});
  assert.equal((await call()).status,201);redirect=true;assert.equal((await call()).status,503);
  assert.equal(stripeCalls,2);assert.equal(releases,1);
 }finally{await mf.dispose();}
});

test('real Workers product editing rejects a stale session and retries from the latest read',async()=>{
 const origin='https://tfrfkvkjmaqnpxdhxumr.supabase.co',site='https://cpvaluemart.com';
 const user='55555555-5555-4555-8555-555555555555',sku='EDITOR-1',path='/api/admin/products';
 const first='a'.repeat(64),second='b'.repeat(64),buyer='c'.repeat(64);
 const adminHashes=[first,second].map(raw=>createHash('sha256').update(raw).digest('hex'));
 let product={sku,version:1,price_cents:1000,description:'Initial description',status:'Draft',stock:10};
 let unavailable=false;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,
  script:await readFile('.cloudflare/output/v1/workers/default/bundle/index.js','utf8'),compatibilityDate:'2026-11-17',
  bindings:{SUPABASE_URL:origin,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture'},
  outboundService:async request=>{
   const url=new URL(request.url),json=(data,status=200)=>new RuntimeResponse(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
   assert.equal(url.origin,origin);
   if(url.pathname.endsWith('resolve_web_session')){
    const {p_hash}=await request.json();
    return json({account:{id:user,email:'editor@example.invalid'},isAdmin:adminHashes.includes(p_hash)});
   }
   if(url.pathname==='/rest/v1/products')return json([product]);
   if(url.pathname.endsWith('admin_write_product')){
    if(unavailable)return new RuntimeResponse('Temporarily unavailable',{status:503});
    const {p_expected_version,p_fields,p_stock}=await request.json();
    if(p_expected_version!==product.version)return json({code:'PT409',message:'Product version changed'},409);
    product={...product,...p_fields,stock:p_stock,version:product.version+1};
    return json(product);
   }
   throw Error('Unexpected runtime fixture route');
  }
 }));
 try{
  const get=session=>mf.dispatchFetch(site+path+'?sku='+sku,{headers:{Cookie:'__Host-cvm-session='+session}});
  const write=(session,data)=>mf.dispatchFetch(site+path,{method:'POST',
   headers:{Origin:site,'Content-Type':'application/json',...(session?{Cookie:'__Host-cvm-session='+session}:{})},
   body:JSON.stringify({sku,...data})});
  const [a,b]=await Promise.all([get(first),get(second)]);
  const [firstRead,secondRead]=await Promise.all([a.json(),b.json()]);
  const winningFields={price_cents:1300,description:'Winning edit',status:'Published'};
  const winning=await write(first,{version:firstRead.products[0].version,fields:winningFields,stock:14});
  assert.equal(winning.status,200);
  const stale={version:secondRead.products[0].version,fields:{price_cents:900,description:'Stale edit',status:'Archived'},stock:3};
  const rejected=await write(second,stale);
  assert.equal(rejected.status,409);
  assert.equal((await rejected.json()).error.code,'VERSION_CONFLICT');
  assert.equal((await write(buyer,stale)).status,403);
  assert.equal((await write(null,stale)).status,401);
  const reloaded=(await (await get(second)).json()).products[0];
  assert.deepEqual(reloaded,{sku,version:2,...winningFields,stock:14});
  const reviewed={version:reloaded.version,fields:{description:'Reviewed edit'},stock:reloaded.stock};
  unavailable=true;
  const failed=await write(second,reviewed);
  assert.equal(failed.status,503);
  assert.equal((await failed.json()).error.code,'AUTH_UNAVAILABLE');
  unavailable=false;
  const retried=await write(second,reviewed);
  assert.equal(retried.status,200);
  assert.deepEqual((await retried.json()).product,{...reloaded,description:'Reviewed edit',version:3});
 }finally{await mf.dispose();}
});
