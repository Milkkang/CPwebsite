import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
const id='99999999-9999-4999-8999-999999999999';
const account={id:'11111111-1111-4111-8111-111111111111',email:'tester@example.invalid',verified:true};
const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake'};
const call=(path,data)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',headers:{Origin:'https://cpvaluemart.com',Cookie:'__Host-cvm-session='+'a'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify(data)}),env);
async function mock(fn,work){const previous=globalThis.fetch;globalThis.fetch=fn;try{await work();}finally{globalThis.fetch=previous;}}
test('unapproved testers cannot reserve stock or contact Stripe',async()=>{
 await mock(async url=>{if(String(url).includes('is_checkout_tester'))return Response.json(false);assert.match(String(url),/resolve_web_session/);return Response.json({account,isAdmin:true});},async()=>{
  assert.equal((await call('/api/checkout/session',{addressId:id})).status,403);
 });
});
test('refund requires administrator; validates provider payment before issuing refund',async()=>{
 for(const isAdmin of [false,true])await mock(async url=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  if(String(url).includes('prepare_test_order_operation'))return Response.json({intent:'pi_test_1',amount:1000,currency:'sgd'});
  assert.match(String(url),/payment_intents\/pi_test_1$/);
  return Response.json({id:'pi_test_1',livemode:true,amount:1000,currency:'sgd',metadata:{order_id:id}});
 },async()=>assert.equal((await call('/api/admin/order-actions',{orderId:id,version:1,action:'refund',restock:true})).status,isAdmin?409:403));
});
test('refund retries keep provider idempotency key and reconcile lost DB response',async()=>{
 const keys=[];let attempts=0,finishes=0;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.includes('prepare_test_order_operation'))return Response.json({completed:false,intent:'pi_test_1',amount:1000,currency:'sgd'});
  if(path.includes('payment_intents/'))return Response.json({id:'pi_test_1',livemode:false,amount:1000,currency:'sgd',metadata:{order_id:id}});
  if(path.includes('/refunds?'))return Response.json({data:[]});
  if(path.endsWith('/refunds')){keys.push(options.headers['Idempotency-Key']);assert.equal(new URLSearchParams(options.body).get('amount'),'1000');attempts++;return Response.json({id:'re_test_1',payment_intent:'pi_test_1',amount:1000,currency:'sgd',status:'succeeded'});}
  if(path.includes('finish_test_order_operation')){finishes++;return finishes===1?Response.json({code:'40001'},{status:409}):Response.json(true);}
  throw Error('Unexpected request');
 },async()=>{
  const data={orderId:id,version:1,action:'refund',restock:true};
  assert.equal((await call('/api/admin/order-actions',data)).status,409);
  assert.equal((await call('/api/admin/order-actions',data)).status,200);
  assert.equal(attempts,2);assert.deepEqual(keys,['refund/'+id,'refund/'+id]);
 });
});
test('pending refund never changes order or inventory',async()=>{
 await mock(async url=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.includes('prepare_test_order_operation'))return Response.json({intent:'pi_test_1',amount:1000,currency:'sgd'});
  if(path.includes('payment_intents/'))return Response.json({id:'pi_test_1',livemode:false,amount:1000,currency:'sgd',metadata:{order_id:id}});
  if(path.includes('/refunds?'))return Response.json({data:[]});
  assert.ok(path.endsWith('/refunds'));return Response.json({id:'re_test_1',payment_intent:'pi_test_1',amount:1000,currency:'sgd',status:'pending'});
 },async()=>assert.equal((await call('/api/admin/order-actions',{orderId:id,version:1,action:'refund',restock:false})).status,409));
});
test('expired checkout is reconciled without expiring it twice',async()=>{
 let finished=false;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.includes('prepare_test_order_operation'))return Response.json({session:'cs_test_1'});
  if(path.endsWith('/checkout/sessions/cs_test_1')){assert.equal(options.method,undefined);return Response.json({id:'cs_test_1',livemode:false,status:'expired'});}
  assert.ok(path.includes('finish_test_order_operation'));finished=true;return Response.json(true);
 },async()=>{
  assert.equal((await call('/api/admin/order-actions',{orderId:id,version:1,action:'cancel',restock:false})).status,200);assert.ok(finished);
 });
});
