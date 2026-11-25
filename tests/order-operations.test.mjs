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
const requestId='99999999-9999-4999-8999-999999999990';
const capturedPayment={id:'pi_test_1',livemode:false,amount:1000,amount_received:1000,status:'succeeded',
 latest_charge:'ch_test_1',currency:'sgd',metadata:{order_id:id}};
const preparedRefund={id:requestId,intent:'pi_test_1',amount:1000,paidAmount:1000,refunded:0,currency:'sgd'};
const refundOperation={orderId:id,version:1,action:'refund',restock:true,requestId};
const stripeRefund={id:'re_test_1',object:'refund',payment_intent:'pi_test_1',charge:'ch_test_1',
 amount:1000,currency:'sgd',status:'succeeded',metadata:{order_id:id,operation_id:requestId}};
test('refund requires administrator and validates the captured payment before issuing a refund',async()=>{
 for(const isAdmin of [false,true])await mock(async url=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  if(String(url).endsWith('/prepare_order_refund'))return Response.json(preparedRefund);
  assert.match(String(url),/payment_intents\/pi_test_1$/);
  return Response.json({...capturedPayment,livemode:true});
 },async()=>{
  const response=await call('/api/admin/order-actions',refundOperation);
  assert.equal(response.status,isAdmin?409:403);
  assert.equal((await response.json()).error.code,isAdmin?'PAYMENT_UNVERIFIED':'ADMIN_REQUIRED');
 });
});
test('refund retries use a stable provider key and reconcile a lost database response without another Stripe refund',async()=>{
 const keys=[];let finishes=0;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.endsWith('/prepare_order_refund'))return Response.json(preparedRefund);
  if(path.includes('payment_intents/'))return Response.json(capturedPayment);
  if(path.includes('/refunds?'))return Response.json({data:keys.length?[stripeRefund]:[],has_more:false});
  if(path.endsWith('/refunds')){
   keys.push(options.headers['Idempotency-Key']);
   assert.equal(new URLSearchParams(options.body).get('amount'),'1000');
   return Response.json(stripeRefund);
  }
  if(path.endsWith('/resolve_order_refund')){finishes++;return finishes===1?Response.json({code:'40001'},{status:409}):Response.json(true);}
  throw Error('Unexpected request');
 },async()=>{
  assert.equal((await call('/api/admin/order-actions',refundOperation)).status,409);
  assert.equal((await call('/api/admin/order-actions',refundOperation)).status,200);
  assert.equal(finishes,2);assert.deepEqual(keys,['refund/'+requestId]);
 });
});
test('resume checks the exact refund request even after the order changed, and never starts an unknown refund',async()=>{
 for(const completed of [null,false,true])await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.endsWith('/resume_order_refund')){
   assert.deepEqual(JSON.parse(options.body),{p_actor:account.id,p_order:id,p_request:requestId,p_live:false});
   return Response.json(completed===null?null:{...preparedRefund,completed,amount:0,restored:50});
  }
  assert.equal(completed,false);
  assert.match(path,/resolve_order_refund$/);
  assert.deepEqual(JSON.parse(options.body),{p_actor:account.id,p_order:id,p_request:requestId,p_live:false,p_provider:null,p_status:'no_cash'});
  return Response.json(true);
 },async()=>{
  const response=await call('/api/admin/order-actions',{orderId:id,action:'resume_refund',requestId});
  assert.equal(response.status,completed===null?409:200);
  const result=await response.json();
  if(completed===null)assert.equal(result.error.code,'REFUND_NOT_FOUND');
  else assert.deepEqual(result.refund,{amount:0,pointsRestored:50,pointsClawedBack:0});
 });
});
test('pending or mismatched Stripe refunds leave the database refund unresolved',async()=>{
 for(const [record,code] of [
  [{...stripeRefund,status:'pending'},'REFUND_PENDING'],
  [{...stripeRefund,livemode:true},'REFUND_UNVERIFIED'],
  [{...stripeRefund,metadata:{order_id:id}},'REFUND_UNVERIFIED'],
  [{...stripeRefund,charge:'ch_other'},'REFUND_UNVERIFIED']
 ])await mock(async url=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.endsWith('/prepare_order_refund'))return Response.json(preparedRefund);
  if(path.includes('payment_intents/'))return Response.json(capturedPayment);
  if(path.includes('/refunds?'))return Response.json({data:[],has_more:false});
  assert.ok(path.endsWith('/refunds'));
  return Response.json(record);
 },async()=>{
  const response=await call('/api/admin/order-actions',refundOperation);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,code);
 });
});
test('verified terminal failure releases the refund slot and no-cash returns bypass Stripe',async()=>{
 for(const amount of [1000,0]){
  let finished=false;
  await mock(async(url,options)=>{
   const path=String(url);
   if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
   if(path.endsWith('/prepare_order_refund'))return Response.json({...preparedRefund,amount});
   if(path.endsWith('/resolve_order_refund')){
    const result=JSON.parse(options.body);
    assert.equal(result.p_status,amount?'failed':'no_cash');
    assert.equal(result.p_provider,amount?'re_test_1':null);
    finished=true;
    return Response.json(true);
   }
   assert.ok(amount,'cashless refund must not contact Stripe');
   if(path.includes('payment_intents/'))return Response.json(capturedPayment);
   assert.ok(path.includes('/refunds?'));
   return Response.json({data:[{...stripeRefund,status:'failed'}],has_more:false});
  },async()=>{
   const response=await call('/api/admin/order-actions',refundOperation);
   assert.equal(response.status,amount?409:200);
   if(amount)assert.equal((await response.json()).error.code,'REFUND_FAILED');
   assert.ok(finished);
  });
 }
});
test('an existing legacy whole refund can be recovered with the original order idempotency key',async()=>{
 let posted=false;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.endsWith('/prepare_order_refund')){
   assert.equal(JSON.parse(options.body).p_request,null);
   return Response.json({...preparedRefund,legacy:true});
  }
  if(path.includes('payment_intents/'))return Response.json(capturedPayment);
  if(path.includes('/refunds?'))return Response.json({data:[],has_more:false});
  if(path.endsWith('/refunds')){
   assert.equal(options.headers['Idempotency-Key'],'refund/'+id);
   assert.equal(new URLSearchParams(options.body).has('metadata[operation_id]'),false);
   posted=true;
   return Response.json({...stripeRefund,metadata:{order_id:id}});
  }
  assert.ok(path.endsWith('/resolve_order_refund'));
  assert.equal(JSON.parse(options.body).p_request,requestId);
  return Response.json(true);
 },async()=>{
  const response=await call('/api/admin/order-actions',{...refundOperation,requestId:null});
  assert.equal(response.status,200);
  assert.ok(posted);
 });
});
test('expired checkout is reconciled without expiring it twice',async()=>{
 let finished=false;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.includes('prepare_order_operation'))return Response.json({session:'cs_test_1'});
  if(path.endsWith('/checkout/sessions/cs_test_1')){assert.equal(options.method,undefined);return Response.json({id:'cs_test_1',livemode:false,status:'expired'});}
  assert.ok(path.includes('finish_test_order_operation'));finished=true;return Response.json(true);
 },async()=>{
  assert.equal((await call('/api/admin/order-actions',{orderId:id,version:1,action:'cancel',restock:false})).status,200);assert.ok(finished);
 });
});

test('partial refund resolves the original item amount after verified Stripe success',async()=>{
 const requestId='99999999-9999-4999-8999-999999999990';
 const items=[{sku:'FIXTURE-A',quantity:1}];
 const metadata={order_id:id,operation_id:requestId};
 let finished=false;
 await mock(async(url,options)=>{
  const path=String(url);
  if(path.includes('resolve_web_session'))return Response.json({account,isAdmin:true});
  if(path.endsWith('/prepare_order_refund')){
   assert.deepEqual(JSON.parse(options.body),{p_actor:account.id,p_order:id,p_version:1,p_request:requestId,p_restock:true,p_live:false,p_items:items});
   return Response.json({id:requestId,intent:'pi_test_1',paidAmount:4500,amount:1800,refunded:0,currency:'sgd',earned:18,restored:80});
  }
  if(path.includes('/payment_intents/'))return Response.json({id:'pi_test_1',livemode:false,amount:4500,amount_received:4500,status:'succeeded',latest_charge:'ch_test_1',currency:'sgd',metadata:{order_id:id}});
  if(path.includes('/refunds?'))return Response.json({data:[],has_more:false});
  if(path.endsWith('/refunds')){
   assert.equal(options.headers['Idempotency-Key'],'refund/'+requestId);
   assert.equal(new URLSearchParams(options.body).get('metadata[operation_id]'),requestId);
   assert.equal(new URLSearchParams(options.body).get('amount'),'1800');
   return Response.json({id:'re_test_1',object:'refund',payment_intent:'pi_test_1',charge:'ch_test_1',amount:1800,currency:'sgd',status:'succeeded',metadata});
  }
  assert.ok(path.endsWith('/resolve_order_refund'));
  assert.deepEqual(JSON.parse(options.body),{p_actor:account.id,p_order:id,p_request:requestId,p_live:false,p_provider:'re_test_1',p_status:'succeeded'});
  finished=true;
  return Response.json(true);
 },async()=>{
  const response=await call('/api/admin/order-actions',{orderId:id,version:1,action:'refund_items',requestId,items,restock:true});
  assert.equal(response.status,200);
  assert.ok(finished);
  assert.deepEqual((await response.json()).refund,{amount:1800,pointsRestored:80,pointsClawedBack:18});
 });
});
