import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.mjs';

const userId='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const purchaseId='99999999-9999-4999-8999-999999999999';
const origin='https://cpvaluemart.com';
const path='/api/membership/annual';
const env={
 SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',
 SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',
 TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'buyer@example.invalid',PAID_MEMBERSHIP_LAUNCH_AT:'2024-01-01T00:00:00Z'
};
const account={id:userId,email:'buyer@example.invalid',verified:true};
const cookie='__Host-cvm-session='+'a'.repeat(64);
const call=(settings=env,{owner=cookie,endpoint=path,method='GET',data={},requestOrigin=origin}={})=>
 worker.fetch(new Request(origin+endpoint,{method,headers:{
  Origin:requestOrigin,Cookie:owner,...(method==='POST'?{'Content-Type':'application/json'}:{})
 },...(method==='POST'?{body:JSON.stringify(data)}:{})}),settings);
async function mocked(handler,fn){
 const original=globalThis.fetch;
 globalThis.fetch=(url,options)=>handler(new URL(url).pathname,options);
 try{await fn();}finally{globalThis.fetch=original;}
}

test('annual pass is off by default before phase three and reads only the signed-in member’s purchase',async()=>{
 let member=account, reads=0;
 await mocked((pathname,options)=>{
  if(pathname.endsWith('/resolve_web_session'))return Response.json({account:member,isAdmin:false});
  assert.match(pathname,/\/rpc\/read_paid_membership$/);
  assert.deepEqual(JSON.parse(options.body),{p_user:member.id,p_livemode:false,p_purchase:purchaseId});
  reads++;
  return Response.json({status:'none',purchaseStatus:member.id===userId?'paid':null});
 },async()=>{
  for(const launch of [undefined,'2026-02-30T00:00:00Z','2999-01-01T00:00:00Z']){
   const disabled={...env,PAID_MEMBERSHIP_LAUNCH_AT:launch};
   assert.equal((await (await call(disabled)).json()).enabled,false);
   assert.equal((await call(disabled,{method:'POST',data:{acceptTerms:true}})).status,403);
  }
  assert.equal((await call(env,{owner:''})).status,401);
  const endpoint=path+'?purchase_id='+purchaseId;
  const own=await (await call(env,{endpoint})).json();
  assert.equal(own.purchaseStatus,'paid');
  assert.equal(own.accountId,userId);
  member={...account,id:otherId};
  assert.equal((await call(env,{endpoint})).status,404);
  assert.equal(reads,2);
 });
});

const session={
 object:'checkout.session',id:'cs_test_annual',livemode:false,amount_total:1990,currency:'sgd',mode:'payment',
 client_reference_id:purchaseId,metadata:{paid_membership_purchase_id:purchaseId,paid_membership_user_id:userId},
 status:'open',url:'https://checkout.stripe.com/c/pay/annual'
};

test('verified members accept terms and resume a standalone, once-only annual payment at the server price',async()=>{
 let attached=false, creates=0;
 const expiresAt=Math.floor(Date.now()/1000)+3600;
 await mocked((pathname,options)=>{
  if(pathname.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(pathname.endsWith('/prepare_paid_membership_checkout')){
   assert.deepEqual(JSON.parse(options.body),{p_user:userId,p_livemode:false,p_origin:origin});
   return Response.json({id:purchaseId,origin,expiresAt,sessionId:attached?session.id:null});
  }
  if(pathname.endsWith('/attach_paid_membership_checkout')){
   assert.deepEqual(JSON.parse(options.body),{p_user:userId,p_livemode:false,p_purchase:purchaseId,p_session:session.id});
   attached=true;
   return Response.json(true);
  }
  if(pathname==='/v1/checkout/sessions'){
   creates++;
   const form=new URLSearchParams(options.body);
   assert.equal(options.headers['Idempotency-Key'],'annual-membership/'+purchaseId);
   assert.equal(form.get('mode'),'payment');
   assert.equal(form.get('line_items[0][price_data][unit_amount]'),'1990');
   assert.equal(form.get('line_items[0][price_data][currency]'),'sgd');
   assert.equal(form.get('adaptive_pricing[enabled]'),'false');
   assert.equal(form.get('metadata[paid_membership_user_id]'),userId);
   assert.equal(form.has('metadata[order_id]'),false);
   assert.equal(form.get('success_url'),origin+'/#/account?purchase_id='+purchaseId+'&annual=return');
   return Response.json(session);
  }
  if(pathname==='/v1/checkout/sessions/'+session.id)return Response.json(session);
  throw Error('Unexpected request '+pathname);
 },async()=>{
  const post=(data,options={})=>call(env,{method:'POST',data,...options});
  assert.equal((await post({})).status,400);
  assert.equal((await post({acceptTerms:true},{requestOrigin:'https://example.invalid'})).status,403);
  for(let i=0;i<2;i++){
   const response=await post({acceptTerms:true,amount:1,userId:otherId});
   assert.equal(response.status,201);
   assert.equal((await response.json()).checkoutUrl,session.url);
  }
  assert.equal(creates,1);
 });
});

function webhook(event,secret='whsec_fake',settings=env){
 const raw=JSON.stringify(event),time=Math.floor(Date.now()/1000);
 const signature=createHmac('sha256',secret).update(time+'.'+raw).digest('hex');
 return worker.fetch(new Request(origin+'/api/stripe/webhook',{method:'POST',headers:{
  'Content-Type':'application/json','Stripe-Signature':'t='+time+',v1='+signature
 },body:raw}),settings);
}

test('only signed paid annual Checkout confirmation can extend the matching account’s pass',async()=>{
 const created=Math.floor(Date.now()/1000);
 const paid={...session,status:'complete',payment_status:'paid',payment_intent:'pi_annual'};
 const event={id:'evt_annual',type:'checkout.session.completed',livemode:false,created,data:{object:paid}};
 let applications=0;
 await mocked((pathname,options)=>{
  assert.match(pathname,/\/rpc\/apply_paid_membership_event$/);
  assert.deepEqual(JSON.parse(options.body),{
   p_event:'evt_annual',p_type:'checkout.session.completed',p_livemode:false,p_purchase:purchaseId,
   p_user:userId,p_session:session.id,p_intent:'pi_annual',p_amount:1990,p_currency:'sgd',
   p_event_at:new Date(created*1000).toISOString()
  });
  applications++;
  return Response.json({status:'paid'});
 },async()=>{
  assert.equal((await webhook(event,'wrong')).status,400);
  assert.equal((await webhook({...event,livemode:true})).status,400);
  for(const invalid of [{mode:'subscription'},{currency:'usd'},{amount_total:1},{livemode:true},{client_reference_id:otherId}]){
   assert.equal((await webhook({...event,data:{object:{...paid,...invalid}}})).status,409);
  }
  assert.equal((await webhook({...event,data:{object:{...paid,payment_status:'unpaid'}}})).status,200);
  assert.equal(applications,0);
  assert.equal((await webhook(event)).status,200);
  assert.equal((await webhook(event,'whsec_fake',{...env,PAID_MEMBERSHIP_LAUNCH_AT:undefined})).status,200);
  assert.equal(applications,2);
 });
});
