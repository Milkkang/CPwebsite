import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {hash,encrypt,decrypt} from '../src/auth-api.mjs';
const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake'};
const userId='11111111-1111-4111-8111-111111111111',authSession='22222222-2222-4222-8222-222222222222';
const token='header.'+Buffer.from(JSON.stringify({sub:userId,session_id:authSession,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fake';
const account={id:userId,email:'test@example.invalid',name:'Test',verified:true};
const request=(path,data,{cookie,origin='https://cpvaluemart.com'}={})=>new Request(origin+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
const run=(path,data,options)=>worker.fetch(request(path,data,options),env);
async function mocked(handler,fn){const original=globalThis.fetch;globalThis.fetch=handler;try{await fn();}finally{globalThis.fetch=original;}}

test('unauthenticated admin/profile writes and cross-site requests are rejected before DB writes',async()=>{
 await mocked(()=>{throw Error('Unexpected request');},async()=>{
  assert.equal((await run('/api/admin/access')).status,401);
  assert.equal((await run('/api/profile',{name:'changed'})).status,401);
  assert.equal((await run('/api/auth/login',{email:'x@y.example',password:'test'},{origin:'https://attacker.example'})).status,403);
  assert.equal((await run('/api/addresses')).status,401);
  const response=await run('/api/auth/session');assert.equal((await response.json()).account,null);
 });
});

test('checkout email is validated and saved only to the signed-in account profile',async()=>{
 const cookie='__Host-cvm-session='+'a'.repeat(64);
 const writes=[];
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:false});
  assert.match(url,/buyer_profiles\?on_conflict=user_id$/);
  assert.equal(options.headers.Prefer,'resolution=merge-duplicates,return=representation');
  writes.push(JSON.parse(options.body));
  return Response.json(writes.slice(-1),{status:201});
 },async()=>{
  for(const data of [{name:'Customer',checkoutEmail:'bad'},{name:'Customer',checkoutEmail:'pay@example.invalid',user_id:'other'}]){
   assert.equal((await run('/api/profile',data,{cookie})).status,400);
  }
  for(const data of [{checkoutEmail:'  PAY@example.invalid  '},{},{checkoutEmail:''}]){
   assert.equal((await run('/api/profile',{name:'Customer',...data},{cookie})).status,200);
  }
  assert.deepEqual(writes,[
   {user_id:userId,display_name:'Customer',checkout_email:'pay@example.invalid'},
   {user_id:userId,display_name:'Customer'},
   {user_id:userId,display_name:'Customer',checkout_email:null}
  ]);
 });
});

test('login stores only a hash and encrypted access token; cookie is opaque, HttpOnly and Secure',async()=>{
 let stored;
 await mocked(async(url,options)=>{
  const path=new URL(url).pathname;
  assert.equal(options.redirect,'manual');
  if(path.startsWith('/rest/'))assert.equal(options.headers.apikey,env.SUPABASE_SECRET_KEY);
  else assert.equal(options.headers.apikey,env.SUPABASE_PUBLISHABLE_KEY);
  if(path.endsWith('consume_auth_limit'))return Response.json(true);
  if(path==='/auth/v1/token')return Response.json({access_token:token,refresh_token:'not-stored'});
  if(path==='/auth/v1/user')return Response.json({id:userId,email:account.email,email_confirmed_at:new Date().toISOString(),user_metadata:{display_name:'Test',is_admin:true}});
  if(path==='/rest/v1/buyer_profiles')return Response.json([]);
  if(path==='/rest/v1/server_sessions'){stored=JSON.parse(options.body);return Response.json([stored]);}
  throw Error('Unexpected request');
 },async()=>{
  const r=await run('/api/auth/login',{email:account.email,password:'user-entered-password'});
  assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie');assert.ok(cookie.includes('HttpOnly; Secure; SameSite=Lax'));assert.ok(cookie.startsWith('__Host-cvm-session='));
  const raw=cookie.split(';')[0].split('=')[1];assert.equal(stored.session_hash,await hash(raw));assert.notEqual(stored.access_token_encrypted,token);assert.equal(await decrypt(stored.access_token_encrypted,env),token);assert.equal('refresh_token'in stored,false);
  const body=await r.text();for(const secret of [token,'not-stored',env.SUPABASE_SECRET_KEY])assert.equal(body.includes(secret),false);
 });
});

test('project Preview origins pass the same-origin guard without allowing other workers.dev hosts',async()=>{
 const preview='https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev';
 await mocked(async url=>new URL(url).pathname==='/auth/v1/token'?Response.json({access_token:token,expires_in:3600,user:account}):Response.json([{}]),async()=>{
  assert.notEqual((await run('/api/auth/login',{email:account.email,password:'test'},{origin:preview})).status,403);
  assert.equal((await run('/api/auth/login',{email:account.email,password:'test'},{origin:'https://other-project.workers.dev'})).status,403);
 });
});

test('database identity controls admin status; recovery session cannot read member data',async()=>{
 const cookie='__Host-cvm-session='+'a'.repeat(64);
 for(const recoveryOnly of [false,true])await mocked(async()=>Response.json({account,isAdmin:false,recoveryOnly}),async()=>{
  const r=await run('/api/admin/access',undefined,{cookie});assert.equal(r.status,403);
  if(recoveryOnly)assert.equal((await run('/api/profile',undefined,{cookie})).status,403);
 });
});

test('only admins can create a product variant and a duplicate SKU gets a specific error',async()=>{
 const cookie='__Host-cvm-session='+'a'.repeat(64);
 const path='/api/admin/products';
 const data={sku:'SOAP-500',variantOf:'SOAP-250',version:0,fields:{variant_name:'500g'},stock:7};
 let isAdmin=false,writes=0;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin});
  assert.match(url,/\/rpc\/admin_add_product_variant$/);
  assert.deepEqual(JSON.parse(options.body),{p_actor:userId,p_parent_sku:data.variantOf,p_sku:data.sku,p_fields:data.fields,p_stock:7});
  writes++;
  return writes===1?Response.json({sku:data.sku,variant_of:data.variantOf}):Response.json({code:'40001'},{status:409});
 },async()=>{
  assert.equal((await run(path,data,{cookie})).status,403);
  isAdmin=true;
  assert.equal((await run(path,{...data,version:1},{cookie})).status,400);
  assert.equal((await run(path,data,{cookie})).status,201);
  const duplicate=await run(path,data,{cookie});
  assert.equal(duplicate.status,409);
  assert.equal((await duplicate.json()).error.code,'SKU_TAKEN');
  assert.equal(writes,2);
 });
});

test('admin coupon deletion uses a versioned soft delete and filters deleted coupons',async()=>{
 const cookie='__Host-cvm-session='+'a'.repeat(64);
 const payload={action:'deleteCoupon',code:'PROMO-10',version:2};
 let isAdmin=false,deleted=false,patches=0;
 await mocked(async(url,options)=>{
  const {pathname,searchParams}=new URL(url);
  if(pathname.endsWith('resolve_web_session'))return Response.json({account,isAdmin});
  if(pathname.endsWith('/homepage_config')||pathname.endsWith('/delivery_rules'))return Response.json([]);
  assert.equal(pathname,'/rest/v1/coupons');
  assert.equal(searchParams.get('deleted_at'),'is.null');
  if(options.method==='GET')return Response.json(deleted?[]:[{code:payload.code,version:2}]);
  assert.equal(options.method,'PATCH');
  assert.equal(searchParams.get('code'),'eq.PROMO-10');
  assert.equal(searchParams.get('version'),'eq.2');
  patches++;
  if(deleted)return Response.json([]);
  const body=JSON.parse(options.body);
  assert.equal(body.active,false);
  assert.ok(Number.isFinite(Date.parse(body.deleted_at)));
  deleted=true;
  return Response.json([{code:payload.code,active:false,version:3}]);
 },async()=>{
  const path='/api/admin/config';
  assert.equal((await run(path,payload,{cookie})).status,403);
  isAdmin=true;
  assert.equal((await run(path,{...payload,version:0},{cookie})).status,400);
  assert.equal((await run(path,{...payload,code:'bad code'},{cookie})).status,400);
  assert.equal((await run(path,payload,{cookie})).status,200);
  const list=await run(path,undefined,{cookie});
  assert.equal(list.status,200);
  assert.deepEqual((await list.json()).coupons,[]);
  assert.equal((await run(path,payload,{cookie})).status,409);
  assert.equal(patches,2);
 });
});

test('logout deletes website session even when upstream logout fails, and old cookie stops working',async()=>{
 let revoked=false;
 const cookie='__Host-cvm-session='+'b'.repeat(64);
 const encrypted=await encrypt(token,env);
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json(revoked?null:{account,isAdmin:true,recoveryOnly:false});
  if(url.includes('server_sessions')&&options.method==='DELETE'){revoked=true;return Response.json([]);}
  if(url.includes('server_sessions'))return Response.json([{access_token_encrypted:encrypted}]);
  if(url.includes('/auth/v1/logout'))throw Error('upstream unavailable');
  throw Error('Unexpected request');
 },async()=>{
  assert.equal((await run('/api/admin/access',undefined,{cookie})).status,200);
  const r=await run('/api/auth/logout',{}, {cookie});assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await run('/api/admin/access',undefined,{cookie})).status,401);
 });
});

test('invalid links and upstream auth errors never return token/password/SMTP details',async()=>{
 await mocked(async(url)=>url.includes('consume_auth_limit')?Response.json(true):Response.json({msg:'secret SMTP internal detail'},{status:400}),async()=>{
  const r=await run('/api/auth/verify',{token_hash:'a'.repeat(64),type:'email'});assert.equal(r.status,400);const text=await r.text();assert.ok(text.includes('INVALID_LINK'));assert.equal(text.includes('SMTP'),false);
  assert.equal((await run('/api/auth/verify',{token_hash:'bad',type:'admin'})).status,400);
 });
});

test('signup confirmation verifies email without creating a login session from the link',async()=>{
 let websiteSessionWritten=false;
 await mocked(async(url,options)=>{
  if(url.includes('consume_auth_limit'))return Response.json(true);
  if(url.includes('/auth/v1/verify'))return Response.json({access_token:token});
  if(url.includes('/auth/v1/user'))return Response.json({id:userId,email:account.email,email_confirmed_at:new Date().toISOString()});
  if(url.includes('/auth/v1/logout'))return new Response(null,{status:204});
  websiteSessionWritten=true;throw Error('Unexpected website session creation');
 },async()=>{
  const r=await run('/api/auth/verify',{token_hash:'c'.repeat(64),type:'email'});
  assert.equal(r.status,200);assert.equal((await r.json()).requiresLogin,true);assert.equal(r.headers.get('set-cookie'),null);assert.equal(websiteSessionWritten,false);
 });
});

test('default address mutations derive ownership from the session and reject another owner',async()=>{
 const cookie='__Host-cvm-session='+'d'.repeat(64),id='88888888-8888-4888-8888-888888888888';let seen;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:false,recoveryOnly:false});
  if(url.includes('change_member_address')){seen=JSON.parse(options.body);return Response.json(null);}
  throw Error('Unexpected request');
 },async()=>{
  const r=await run('/api/addresses/'+id,{action:'default'},{cookie});assert.equal(r.status,404);
  assert.deepEqual(seen,{p_user_id:userId,p_action:'default',p_address_id:id});
  assert.equal((await run('/api/addresses/'+id,{action:'default',user_id:'another-user'},{cookie})).status,400);
 });
});

test('shopping writes use the verified session owner and reject invalid guest or cross-site requests',async()=>{
 const cookie='__Host-cvm-session='+'9'.repeat(64);let setBody;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:false,recoveryOnly:false});
  if(url.includes('set_member_cart')){setBody=JSON.parse(options.body);return Response.json({sku:'SKU_1',quantity:2});}
  if(url.includes('read_member_shopping'))return Response.json({cart:[],saved:[],recent:[]});
  throw Error('Unexpected database request');
 },async()=>{
  assert.equal((await run('/api/shopping')).status,401);
  assert.equal((await run('/api/shopping',{action:'cart',sku:'SKU_1',quantity:2},{origin:'https://attacker.example',cookie})).status,403);
  assert.equal((await run('/api/shopping',{action:'cart',sku:'SKU_1',quantity:2,user_id:'another-user'},{cookie})).status,400);
  assert.equal((await run('/api/shopping',{action:'cart',sku:'SKU_1',quantity:2},{cookie})).status,200);
  assert.deepEqual(setBody,{p_user:userId,p_sku:'SKU_1',p_quantity:2});
  assert.equal((await run('/api/shopping',{action:'cart',sku:'SKU_1',quantity:-1},{cookie})).status,400);
  assert.equal((await run('/api/shopping',undefined,{cookie})).status,200);
 });
});

test('admin product mutations bind actor and version to the verified admin session',async()=>{
 const cookie='__Host-cvm-session='+'8'.repeat(64);let write;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:true,recoveryOnly:false});
  if(url.includes('admin_write_product')){write=JSON.parse(options.body);return Response.json({sku:'SKU_1',version:5});}
  throw Error('Unexpected database request');
 },async()=>{
  const payload={sku:'SKU_1',version:4,fields:{price_cents:499},stock:10};
  const response=await run('/api/admin/products',payload,{cookie});
  assert.equal(response.status,200);
  assert.deepEqual(write,{p_actor:userId,p_sku:'SKU_1',p_expected_version:4,p_fields:{price_cents:499},p_stock:10});
  assert.equal((await run('/api/admin/products',{...payload,fields:{admin_roles:'all'}},{cookie})).status,400);
  assert.equal((await run('/api/admin/products',payload)).status,401);
 });
});

test('admin config reports a version conflict without claiming a save',async()=>{
 const cookie='__Host-cvm-session='+'7'.repeat(64);
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:true,recoveryOnly:false});
  if(url.includes('delivery_rules')){assert.equal(options.method,'PATCH');assert.equal(new URL(url).searchParams.get('version'),'eq.3');return Response.json([]);}
  throw Error('Unexpected database request');
 },async()=>{
  const response=await run('/api/admin/config',{action:'delivery',version:3,shipping:390,threshold:5000},{cookie});
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'VERSION_CONFLICT');
 });
});

test('wrong current password keeps the website session and never updates the password',async()=>{
 const cookie='__Host-cvm-session='+'e'.repeat(64);let changed=false,deleted=false;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json({account,isAdmin:false,recoveryOnly:false});
  if(url.includes('consume_auth_limit'))return Response.json(true);
  if(url.includes('/auth/v1/token'))return Response.json({msg:'Invalid login credentials'},{status:400});
  if(options.method==='PUT'&&url.includes('/auth/v1/user'))changed=true;
  if(options.method==='DELETE'&&url.includes('server_sessions'))deleted=true;
  throw Error('Unexpected request');
 },async()=>{
  const r=await run('/api/auth/password',{currentPassword:'incorrect',password:'new-password-1234'},{cookie});
  assert.equal(r.status,400);assert.equal((await r.json()).error.code,'CURRENT_PASSWORD_INCORRECT');
  assert.equal(r.headers.get('set-cookie'),null);assert.equal(changed,false);assert.equal(deleted,false);
  assert.equal((await run('/api/admin/access',undefined,{cookie})).status,403);
 });
});

test('correct current password updates it and revokes website sessions',async()=>{
 const cookie='__Host-cvm-session='+'f'.repeat(64),encrypted=await encrypt(token,env);let changed=false,deleted=false,loggedOut=false;
 await mocked(async(url,options)=>{
  if(url.includes('resolve_web_session'))return Response.json(deleted?null:{account,isAdmin:false,recoveryOnly:false});
  if(url.includes('consume_auth_limit'))return Response.json(true);
  if(url.includes('/auth/v1/token'))return Response.json({access_token:token,user:{id:userId}});
  if(url.includes('/auth/v1/logout')){loggedOut=true;return Response.json({});}
  if(url.includes('server_sessions')&&options.method==='DELETE'){deleted=true;return Response.json([]);}
  if(url.includes('server_sessions'))return Response.json([{access_token_encrypted:encrypted}]);
  if(url.includes('/auth/v1/user')&&options.method==='PUT'){changed=true;assert.equal(JSON.parse(options.body).password,'new-password-1234');return Response.json({id:userId});}
  throw Error('Unexpected request');
 },async()=>{
  const r=await run('/api/auth/password',{currentPassword:'old-password',password:'new-password-1234'},{cookie});
  assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal(changed,true);assert.equal(deleted,true);assert.equal(loggedOut,true);
  assert.equal((await run('/api/auth/session',undefined,{cookie})).status,200);
  assert.equal((await (await run('/api/auth/session',undefined,{cookie})).json()).account,null);
 });
});
