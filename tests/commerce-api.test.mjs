import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'buyer@example.invalid'};
const userId='11111111-1111-4111-8111-111111111111',addressId='88888888-8888-4888-8888-888888888888',orderId='99999999-9999-4999-8999-999999999999';
const account={id:userId,email:'buyer@example.invalid',name:'Buyer',verified:true};
const cookie='__Host-cvm-session='+'a'.repeat(64);
const call=(path,data,{origin='https://cpvaluemart.com'}={})=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
async function mocked(handler,fn){const original=globalThis.fetch;globalThis.fetch=handler;try{await fn();}finally{globalThis.fetch=original;}}

test('checkout derives the order total on the server and creates only a Stripe test session',async()=>{
 let stripeForm,attached;
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin:false,recoveryOnly:false});
  if(String(url).includes('create_test_order'))return Response.json({id:orderId,number:'CVM-1000',payment_status:'pending',fulfilment_status:'Processing',tracking_number:'',subtotal_cents:1000,shipping_cents:390,discount_cents:50,total_cents:1340,created_at:new Date().toISOString(),items:[]});
  if(String(url)==='https://api.stripe.com/v1/checkout/sessions'){
   assert.equal(options.headers.Authorization,'Bearer sk_test_fake');stripeForm=new URLSearchParams(options.body);
   return Response.json({id:'cs_test_123',url:'https://checkout.stripe.com/c/pay/cs_test_123',livemode:false});
  }
  if(String(url).includes('attach_test_checkout')){attached=JSON.parse(options.body);return Response.json(true);}
  throw Error('Unexpected request '+url);
 },async()=>{
  const response=await call('/api/checkout/session',{addressId,coupon:'WELCOME5',total:1});
  assert.equal(response.status,201);const body=await response.json();assert.equal(body.testMode,true);
  assert.equal(stripeForm.get('line_items[0][price_data][unit_amount]'),'1340');
  assert.equal(stripeForm.get('metadata[order_id]'),orderId);assert.equal(stripeForm.has('total'),false);
  assert.deepEqual(attached,{p_user:userId,p_order:orderId,p_session:'cs_test_123'});
 });
});

test('checkout availability and session creation use the same account restrictions',async()=>{
 const path='/api/checkout/session';
 let approved=false;
 let member={...account,email:'shopper@example.invalid'};
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account:member,isAdmin:false});
  assert.match(String(url),/is_checkout_tester$/);
  assert.deepEqual(JSON.parse(options.body),{p_user:userId});
  return Response.json(approved);
 },async()=>{
  assert.equal((await (await call(path)).json()).available,false);
  const denied=await call(path,{addressId});
  assert.equal(denied.status,403);
  assert.equal((await denied.json()).error.message,'Online ordering is currently unavailable.');
  approved=true;
  assert.equal((await (await call(path)).json()).available,true);
  member={...account,verified:false};
  assert.equal((await (await call(path)).json()).available,false);
  assert.equal((await call(path,{addressId})).status,403);
  member=account;
  assert.equal((await (await call(path)).json()).available,true);
 });
});

test('checkout rejects cross-site requests and missing test credentials before order creation',async()=>{
 await mocked(async url=>{if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin:false});throw Error('Unexpected network request');},async()=>{
  assert.equal((await call('/api/checkout/session',{addressId},{origin:'https://attacker.example'})).status,403);
  const original=env.STRIPE_SECRET_KEY;env.STRIPE_SECRET_KEY='sk_live_forbidden';
  assert.equal((await call('/api/checkout/session',{addressId})).status,503);env.STRIPE_SECRET_KEY=original;
 });
});

async function signedRequest(event){
 const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw));
 const signature=[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
 return new Request('https://cpvaluemart.com/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${timestamp},v1=${signature}`},body:raw});
}
test('webhook verifies its signature, rejects live events and forwards only server payment fields',async()=>{
 const event={id:'evt_test_1',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test_123',payment_status:'paid',payment_intent:'pi_test_1',amount_total:1340,currency:'sgd',metadata:{order_id:orderId}}}};let applied;
 await mocked(async(url,options)=>{if(String(url).includes('apply_test_payment_event')){applied=JSON.parse(options.body);return Response.json({duplicate:false,outcome:'paid'});}throw Error('Unexpected request');},async()=>{
  assert.equal((await worker.fetch(await signedRequest(event),env)).status,200);
  assert.deepEqual(applied,{p_event:'evt_test_1',p_type:'checkout.session.completed',p_livemode:false,p_order:orderId,p_session:'cs_test_123',p_intent:'pi_test_1',p_amount:1340,p_currency:'sgd'});
  const bad=new Request('https://cpvaluemart.com/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':'t=1,v1='+'0'.repeat(64)},body:JSON.stringify(event)});
  assert.equal((await worker.fetch(bad,env)).status,400);
  assert.equal((await worker.fetch(await signedRequest({...event,id:'evt_live',livemode:true}),env)).status,400);
 });
});

test('bulk shipping checks admin access and submits distinct orders in a single RPC',async()=>{
 const path='/api/admin/orders/bulk-ship';
 const orders=[
  {orderId,version:3,tracking:' COURIER-1 '},
  {orderId:addressId,version:4,tracking:'COURIER-2'}
 ];
 let isAdmin=false,conflict=false,calls=0;
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  assert.match(String(url),/\/rpc\/admin_bulk_ship_orders$/);
  calls++;
  assert.deepEqual(JSON.parse(options.body),{p_actor:userId,p_orders:[
   {id:orderId,version:3,tracking:'COURIER-1'},{id:addressId,version:4,tracking:'COURIER-2'}
  ]});
  return conflict?Response.json({code:'40001'},{status:400}):Response.json(2);
 },async()=>{
  assert.equal((await call(path,{orders})).status,403);
  isAdmin=true;
  assert.equal((await call(path,{orders},{origin:'https://example.invalid'})).status,403);
  assert.equal((await call(path,{orders:[orders[0],orders[0]]})).status,400);
  assert.equal((await call(path,{orders:[{...orders[0],tracking:' '}]})).status,400);
  assert.equal(calls,0);
  const success=await call(path,{orders});
  assert.equal(success.status,200);
  assert.equal((await success.json()).shipped,2);
  conflict=true;
  const stale=await call(path,{orders});
  assert.equal(stale.status,409);
  assert.equal((await stale.json()).error.code,'VERSION_CONFLICT');
  assert.equal(calls,2);
 });
});
