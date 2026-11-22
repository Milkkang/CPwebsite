import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/worker.mjs';

const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'buyer@example.invalid'};
const userId='11111111-1111-4111-8111-111111111111',addressId='88888888-8888-4888-8888-888888888888',orderId='99999999-9999-4999-8999-999999999999';
const account={id:userId,email:'buyer@example.invalid',name:'Buyer',verified:true};
const cookie='__Host-cvm-session='+'a'.repeat(64);
const call=(path,data,{origin='https://cpvaluemart.com',sessionCookie=cookie}={})=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:sessionCookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
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
test('checkout return reports the matched order before and after a signed payment even with an older paid order',async()=>{
 const rows=[
  {stripe_checkout_session_id:'cs_test_old',user_id:userId,order_number:1050,payment_status:'paid'},
  {stripe_checkout_session_id:'cs_test_current',user_id:userId,order_number:1051,payment_status:'pending'}
 ];
 await mocked(async(url,options)=>{
  const path=new URL(url);
  if(path.pathname.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(path.pathname.endsWith('/apply_test_payment_event')){
   const event=JSON.parse(options.body);
   if(event.p_order===orderId&&event.p_session==='cs_test_current'&&event.p_amount===1340&&event.p_currency==='sgd')rows[1].payment_status='paid';
   return Response.json({duplicate:false});
  }
  if(path.pathname==='/rest/v1/orders'&&options.method==='GET'){
   return Response.json(rows.filter(row=>path.searchParams.get('stripe_checkout_session_id')==='eq.'+row.stripe_checkout_session_id&&path.searchParams.get('user_id')==='eq.'+row.user_id));
  }
  throw Error('Unexpected request '+path.pathname);
 },async()=>{
  const resultPath='/api/checkout/status?session_id=cs_test_current';
  const pending=await call(resultPath);
  assert.equal(pending.status,200);
  assert.equal(pending.headers.get('Cache-Control'),'no-store');
  const {requestId,...result}=await pending.json();
  assert.deepEqual(result,{orderNumber:'CVM-1051',paymentStatus:'pending'});
  const event={id:'evt_checkout_return',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_test_current',payment_status:'paid',payment_intent:'pi_test_current',amount_total:1340,currency:'sgd',metadata:{order_id:orderId}}}};
  assert.equal((await worker.fetch(await signedRequest(event),env)).status,200);
  const {requestId:paidRequest,...paid}=await (await call(resultPath)).json();
  assert.deepEqual(paid,{orderNumber:'CVM-1051',paymentStatus:'paid'});
 });
});
test('a checkout link is unavailable to another account and an expired login can reauthenticate',async()=>{
 const otherId='22222222-2222-4222-8222-222222222222';
 const hash=letter=>createHash('sha256').update(letter.repeat(64)).digest('hex');
 const sessions=new Map([[hash('a'),account],[hash('b'),{...account,id:otherId}],[hash('d'),account]]);
 const reference='/api/checkout/status?session_id=cs_test_owner';
 await mocked(async(url,{method,body})=>{
  const path=new URL(url);
  if(path.pathname.endsWith('/resolve_web_session')){
   const current=sessions.get(JSON.parse(body).p_hash);
   return Response.json(current?{account:current,isAdmin:false}:null);
  }
  if(path.pathname==='/rest/v1/orders'&&method==='GET'){
   const owned=path.searchParams.get('user_id')==='eq.'+userId;
   const matched=path.searchParams.get('stripe_checkout_session_id')==='eq.cs_test_owner';
   return Response.json(owned&&matched?[{order_number:1052,payment_status:'paid'}]:[]);
  }
  throw Error('Unexpected request '+path.pathname);
 },async()=>{
  const sessionCookie=letter=>'__Host-cvm-session='+letter.repeat(64);
  const expired=await call(reference,undefined,{sessionCookie:sessionCookie('c')});
  assert.equal(expired.status,401);
  const foreign=await call(reference,undefined,{sessionCookie:sessionCookie('b')});
  const missing=await call('/api/checkout/status?session_id=cs_test_unknown');
  const duplicate=await call(reference+'&session_id=cs_test_unknown');
  const errors=[];
  for(const response of [foreign,missing,duplicate]){
   assert.equal(response.status,404);
   assert.equal(response.headers.get('Cache-Control'),'no-store');
   errors.push((await response.json()).error);
  }
  assert.deepEqual(errors,Array(3).fill({code:'CHECKOUT_NOT_FOUND',message:'This test checkout is unavailable.'}));
  const restored=await call(reference,undefined,{sessionCookie:sessionCookie('d')});
  assert.equal(restored.status,200);
  const {requestId,...result}=await restored.json();
  assert.deepEqual(result,{orderNumber:'CVM-1052',paymentStatus:'paid'});
  assert.equal((await call(reference,{})).status,405);
 });
});

test('checkout status distinguishes an upstream failure from a terminal payment',async()=>{
 let result=Response.json({}, {status:503});
 await mocked(async url=>{
  const path=new URL(url);
  if(path.pathname.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(path.pathname==='/rest/v1/orders')return result;
  throw Error('Unexpected request '+path.pathname);
 },async()=>{
  const path='/api/checkout/status?session_id=cs_test_final';
  assert.equal((await call(path)).status,503);
  for(const status of ['expired','failed','refunded']){
   result=Response.json([{order_number:1053,payment_status:status}]);
   const response=await call(path);
   assert.equal(response.status,200);
   const {requestId,...body}=await response.json();
   assert.deepEqual(body,{orderNumber:'CVM-1053',paymentStatus:status});
  }
 });
});
test('order details can read one older order in the current account',async()=>{
 await mocked(async url=>{
  const path=new URL(url);
  if(path.pathname.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(path.pathname==='/rest/v1/orders'){
   if(path.searchParams.get('user_id')!=='eq.'+userId||path.searchParams.get('order_number')!=='eq.1051')return Response.json([]);
   return Response.json([{order_number:1051,payment_status:'paid',order_items:[]}]);
  }
  throw Error('Unexpected request '+path.pathname);
 },async()=>{
  const response=await call('/api/orders?id=CVM-1051');
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).orders.map(order=>order.number),['CVM-1051']);
  assert.deepEqual((await (await call('/api/orders?id=CVM-1053')).json()).orders,[]);
 });
});
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

test('checkout rejects a removed delivery address before creating a Stripe session',async()=>{
 await mocked(async(url)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin:false});
  if(String(url).includes('create_test_order'))return Response.json({message:'ADDRESS_INVALID'},{status:400});
  throw Error('Unexpected request');
 },async()=>{
  const response=await call('/api/checkout/session',{addressId});
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,'ADDRESS_INVALID');
 });
});

test('admin order detail exposes delivery recipient separately from the customer name',async()=>{
 for(const isAdmin of [false,true])await mocked(async(url)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  if(isAdmin&&String(url).includes('read_admin_orders'))return Response.json([{
   id:orderId,number:'CVM-1000',email:account.email,customer_name:'Member Profile',
   full_name:'Original Recipient',address_line:'Test Address',postal_code:'001234'
  }]);
  throw Error('Unexpected request');
 },async()=>{
  const response=await call('/api/admin/orders');
  assert.equal(response.status,isAdmin?200:403);
  if(isAdmin){
   const [order]=(await response.json()).orders;
   assert.equal(order.name,'Member Profile');
   assert.deepEqual(order.address,{name:'Original Recipient',line:'Test Address',postal:'001234'});
  }
 });
});
