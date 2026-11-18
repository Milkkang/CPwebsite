import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {hash,encrypt,decrypt} from '../src/auth-api.mjs';
const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake'};
const userId='11111111-1111-4111-8111-111111111111',authSession='22222222-2222-4222-8222-222222222222';
const token='header.'+Buffer.from(JSON.stringify({sub:userId,session_id:authSession,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.fake';
const account={id:userId,email:'test@example.invalid',name:'Test',verified:true};
const request=(path,data,{cookie,origin='https://cpvaluemart.com'}={})=>new Request('https://cpvaluemart.com'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
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

test('database identity controls admin status; recovery session cannot read member data',async()=>{
 const cookie='__Host-cvm-session='+'a'.repeat(64);
 for(const recoveryOnly of [false,true])await mocked(async()=>Response.json({account,isAdmin:false,recoveryOnly}),async()=>{
  const r=await run('/api/admin/access',undefined,{cookie});assert.equal(r.status,403);
  if(recoveryOnly)assert.equal((await run('/api/profile',undefined,{cookie})).status,403);
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
