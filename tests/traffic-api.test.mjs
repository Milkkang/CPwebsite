import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {analyticsData} from '../dist/analytics.js';

const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',SUPABASE_SECRET_KEY:'sb_secret_fixture'};
const send=(event,origin='https://cpvaluemart.com')=>worker.fetch(new Request('https://cpvaluemart.com/api/traffic',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({event})}),env);

test('traffic accepts only same-origin bounded events and writes through service RPC',async()=>{
 const previous=globalThis.fetch,events=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(options.headers.apikey,env.SUPABASE_SECRET_KEY);
  if(String(url).endsWith('/consume_auth_limit')){const limit=JSON.parse(options.body);assert.equal(limit.p_limit,100);assert.equal(limit.p_seconds,60);return Response.json(true);}
  if(String(url).endsWith('/record_site_traffic')){events.push(JSON.parse(options.body).p_event);return Response.json(null);}
  throw Error('Unexpected database request');
 };
 try{
  assert.equal((await send('visit')).status,202);
  assert.equal((await send('cart')).status,202);
  assert.deepEqual(events,['visit','cart']);
  assert.equal((await send('visit','https://elsewhere.example')).status,403);
  assert.equal((await send('wrong')).status,400);
  const wrongMethod=await worker.fetch(new Request('https://cpvaluemart.com/api/traffic'),env);
  assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get('Allow'),'POST');
  assert.deepEqual(events,['visit','cart']);
 }finally{globalThis.fetch=previous;}
});

test('admin traffic remains private and real counts enter only traffic metrics',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async url=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account:{id:'11111111-1111-4111-8111-111111111111'},isAdmin:true});
  if(String(url).includes('daily_site_traffic'))return Response.json([{day:'2026-11-20',visit_sessions:12,cart_sessions:3}]);
  throw Error('Unexpected database request');
 };
 try{
  const request=new Request('https://cpvaluemart.com/api/admin/traffic',{headers:{Cookie:'__Host-cvm-session='+'a'.repeat(64)}});
  assert.equal((await worker.fetch(new Request(request.url),env)).status,401);
  const response=await worker.fetch(request,env);assert.equal(response.status,200);
  const rows=(await response.json()).traffic;
  const result=analyticsData({from:'2026-11-20',to:'2026-11-20'},'1d',[],rows);
  assert.equal(result.totals.visitors,12);assert.equal(result.totals.cartVisitors,3);assert.equal(result.totals.sales,0);
  const categoryWrite=await worker.fetch(new Request('https://cpvaluemart.com/api/admin/categories',{method:'POST',headers:{Cookie:'__Host-cvm-session='+'a'.repeat(64),Origin:'https://cpvaluemart.com','Content-Type':'application/json'},body:'{}'}),env);
  assert.equal(categoryWrite.status,405);
 }finally{globalThis.fetch=previous;}
});
