import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake',STRIPE_SECRET_KEY:'sk_test_fake',STRIPE_WEBHOOK_SECRET:'whsec_fake',TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'buyer@example.invalid'};
const userId='11111111-1111-4111-8111-111111111111',addressId='88888888-8888-4888-8888-888888888888',orderId='99999999-9999-4999-8999-999999999999';
const account={id:userId,email:'buyer@example.invalid',name:'Buyer',verified:true};
const cookie='__Host-cvm-session='+'a'.repeat(64);
const call=(path,data,{origin='https://cpvaluemart.com'}={})=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:data===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
async function mocked(handler,fn){const original=globalThis.fetch;globalThis.fetch=handler;try{await fn();}finally{globalThis.fetch=original;}}

test('membership reads only the verified account on the current session',async()=>{
 const otherId='22222222-2222-4222-8222-222222222222';
 const launch='2026-11-24T00:00:00Z';
 let member=account, reads=0;
 const request=()=>new Request('https://cpvaluemart.com/api/membership?userId='+otherId,{headers:{Cookie:cookie}});
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json(member?{account:member,isAdmin:false}:null);
  assert.match(String(url),/\/rpc\/read_membership$/);
  assert.deepEqual(JSON.parse(options.body),{p_user:member.id,p_launch:launch,p_live:false});
  reads++;
  return Response.json({enabled:true,member:true,welcome:member.id===userId?{
   status:'available',discount:300,minimum:5000,expiresAt:'2026-12-24T00:00:00Z'
  }:null});
 },async()=>{
  const settings={...env,MEMBERSHIP_LAUNCH_AT:launch};
  assert.equal((await (await worker.fetch(request(),settings)).json()).welcome.discount,300);
  member={...account,id:otherId};
  assert.equal((await (await worker.fetch(request(),settings)).json()).welcome,null);
  member={...account,verified:false};
  assert.equal((await (await worker.fetch(request(),settings)).json()).member,false);
  member=account;
  assert.equal((await (await worker.fetch(request(),env)).json()).enabled,false);
  member=null;
  assert.equal((await worker.fetch(request(),settings)).status,401);
  assert.equal(reads,2);
 });
});

test('membership preview uses only its explicitly configured Sandbox database host',async()=>{
 const ref='a'.repeat(20),isolated='https://'+ref+'.supabase.co';
 const request=()=>new Request('https://fixture-cpwebsite.milkkang93.workers.dev/api/membership',{headers:{Cookie:cookie}});
 let calls=0;
 await mocked(async url=>{
  assert.equal(new URL(url).origin,isolated);
  calls++;
  return Response.json({account,isAdmin:false});
 },async()=>{
  const settings={...env,STRIPE_CHECKOUT_MODE:'sandbox',SUPABASE_URL:isolated,MEMBERSHIP_PREVIEW_SUPABASE_REF:ref};
  assert.equal((await worker.fetch(request(),settings)).status,200);
  assert.equal((await worker.fetch(request(),{...settings,STRIPE_CHECKOUT_MODE:'live'})).status,503);
  assert.equal((await worker.fetch(request(),{...settings,SUPABASE_URL:isolated+'.example.invalid'})).status,503);
  assert.equal((await worker.fetch(request(),{...settings,MEMBERSHIP_PREVIEW_SUPABASE_REF:undefined})).status,503);
  assert.equal(calls,1);
 });
});

test('consumption tiers open independently for the signed-in verified member',async()=>{
 const first='2026-01-01T00:00:00Z',second='2026-02-01T00:00:00Z';
 const tier={tier:'silver',qualifyingSpend:30000,multiplier:125,nextTier:'gold',nextThreshold:80000};
 const request=()=>new Request('https://cpvaluemart.com/api/membership?userId='+addressId,{headers:{Cookie:cookie}});
 const settings={...env,STRIPE_CHECKOUT_MODE:'live',MEMBERSHIP_LAUNCH_AT:first};
 let member=account;
 let tierReads=0;
 await mocked(async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/resolve_web_session'))return Response.json({account:member,isAdmin:false});
  if(path.endsWith('/read_membership'))return Response.json({enabled:true,member:true,welcome:null});
  if(path.endsWith('/read_member_points'))return Response.json({available:0,pending:0,expiring:0,ledger:[]});
  if(path.endsWith('/read_membership_tier')){
   assert.deepEqual(JSON.parse(options.body),{p_user:member.id});
   return Response.json(++tierReads===1?tier:{tier:'base',qualifyingSpend:0,multiplier:100,nextTier:'silver',nextThreshold:30000});
  }
  throw Error('Unexpected request '+url);
 },async()=>{
  for(const launch of [undefined,'invalid','2099-02-01T00:00:00Z','2025-12-31T23:59:59Z']){
   const response=await worker.fetch(request(),{...settings,MEMBERSHIP_TIERS_LAUNCH_AT:launch});
   assert.equal((await response.json()).spendingTier,undefined);
  }
  assert.equal((await (await worker.fetch(request(),{...settings,STRIPE_CHECKOUT_MODE:'sandbox',MEMBERSHIP_TIERS_LAUNCH_AT:second})).json()).spendingTier,undefined);
  const enabled={...settings,MEMBERSHIP_TIERS_LAUNCH_AT:second};
  assert.deepEqual((await (await worker.fetch(request(),enabled)).json()).spendingTier,tier);
  member={...account,id:addressId};
  assert.equal((await (await worker.fetch(request(),enabled)).json()).spendingTier.tier,'base');
  member={...member,verified:false};
  assert.equal((await (await worker.fetch(request(),enabled)).json()).spendingTier,undefined);
  assert.equal(tierReads,2);
 });
});

test('checkout quotes the welcome discount for the session owner and cannot stack a public coupon',async()=>{
 const launch='2026-11-24T00:00:00Z';
 const settings={...env,MEMBERSHIP_LAUNCH_AT:launch};
 const path='/api/checkout/quote';
 const post=(path,body)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',
  headers:{Origin:'https://cpvaluemart.com',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}),settings);
 let rejected=false;
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin:false});
  assert.match(String(url),/\/rpc\/quote_welcome_checkout$/);
  assert.deepEqual(JSON.parse(options.body),{p_user:userId,p_launch:launch,p_live:false});
  return rejected?Response.json({message:'WELCOME_MINIMUM'},{status:409}):Response.json({subtotal:5000,shipping:0,discount:300,total:4700});
 },async()=>{
  const {subtotal,shipping,discount,total}=await (await post(path,{memberCoupon:'welcome',userId:addressId,total:1})).json();
  assert.deepEqual({subtotal,shipping,discount,total},{subtotal:5000,shipping:0,discount:300,total:4700});
  rejected=true;
  assert.equal((await (await post(path,{memberCoupon:'welcome'})).json()).error.code,'WELCOME_MINIMUM');
  for(const endpoint of [path,'/api/checkout/session']){
   const response=await post(endpoint,{addressId,memberCoupon:'welcome',coupon:'PUBLIC',quotedTotal:4700});
   assert.equal(response.status,400);
   assert.equal((await response.json()).error.code,'MULTIPLE_COUPONS');
  }
 });
});

test('a welcome checkout charges the authoritative quoted total and is only cancelled after provider expiry',async()=>{
 const launch='2026-11-24T00:00:00Z';
 const settings={...env,MEMBERSHIP_LAUNCH_AT:launch};
 const session={id:'cs_test_welcome',livemode:false,amount_total:4700,currency:'sgd',client_reference_id:orderId,
  metadata:{order_id:orderId},status:'open',url:'https://checkout.stripe.com/c/pay/welcome'};
 const path='/api/checkout/session';
 const post=(path,body)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',
  headers:{Origin:'https://cpvaluemart.com',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}),settings);
 let expired=false;
 await mocked(async(url,options)=>{
  const pathname=new URL(url).pathname;
  if(pathname.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(pathname.endsWith('/create_welcome_order')){
   assert.deepEqual(JSON.parse(options.body),{p_user:userId,p_address:addressId,p_launch:launch,p_live:false,p_expected_total:4700});
   return Response.json({id:orderId,number:'CVM-1000',subtotal_cents:5000,shipping_cents:0,discount_cents:300,total_cents:4700,
    items:[{product_name:'QA',variant_name:'QA',unit_cents:5000,quantity:1}]});
  }
  if(pathname==='/v1/checkout/sessions'){
   assert.equal(new URLSearchParams(options.body).get('line_items[0][price_data][unit_amount]'),'4700');
   return Response.json(session);
  }
  if(pathname.endsWith('/attach_test_checkout'))return Response.json(true);
  if(pathname.endsWith('/read_pending_welcome_checkout')){
   assert.deepEqual(JSON.parse(options.body),{p_user:userId});
   return Response.json({id:orderId,stripe_checkout_session_id:session.id});
  }
  if(pathname.endsWith('/'+session.id))return Response.json(session);
  if(pathname.endsWith('/expire')){expired=true;return Response.json({...session,status:'expired'});}
  if(pathname.endsWith('/cancel_welcome_checkout')){
   assert.equal(expired,true);
   assert.deepEqual(JSON.parse(options.body),{p_user:userId,p_order:orderId,p_session:session.id});
   return Response.json(true);
  }
  throw Error('Unexpected request '+url);
 },async()=>{
  const created=await post(path,{addressId,memberCoupon:'welcome',quotedTotal:4700,total:1});
  assert.equal(created.status,201);
  assert.equal((await created.json()).checkoutUrl,session.url);
  const cancelled=await post('/api/checkout/manage',{action:'cancel'});
  assert.equal(cancelled.status,200);
  assert.equal((await cancelled.json()).cancelled,true);
 });
});

test('checkout derives the order total on the server and creates only a Stripe test session',async()=>{
 let stripeForm,attached,member={...account,checkoutEmail:'pay@example.invalid'};
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account:member,isAdmin:false,recoveryOnly:false});
  if(String(url).includes('create_test_order'))return Response.json({id:orderId,number:'CVM-1000',payment_status:'pending',fulfilment_status:'Processing',tracking_number:'',subtotal_cents:1000,shipping_cents:390,discount_cents:50,total_cents:1340,created_at:new Date().toISOString(),items:[{product_name:'Dental floss',variant_name:'Unwaxed 50 m',image_url:'https://cdn.example.invalid/floss.jpg',unit_cents:250,quantity:3},{product_name:'Soap',variant_name:'Classic',image_url:'https://',unit_cents:250,quantity:1}]});
  if(String(url)==='https://api.stripe.com/v1/checkout/sessions'){
   assert.equal(options.headers.Authorization,'Bearer sk_test_fake');stripeForm=new URLSearchParams(options.body);
   return Response.json({id:'cs_test_123',url:'https://checkout.stripe.com/c/pay/cs_test_123',livemode:false});
  }
  if(String(url).includes('attach_test_checkout')){attached=JSON.parse(options.body);return Response.json(true);}
  throw Error('Unexpected request '+url);
 },async()=>{
  const response=await call('/api/checkout/session',{addressId,coupon:'WELCOME5',total:1,checkoutEmail:'ignored@example.invalid'});
  assert.equal(response.status,201);const body=await response.json();assert.equal(body.testMode,true);
  const row=(i,key)=>stripeForm.get('line_items['+i+']'+key);
  assert.equal(row(0,'[price_data][product_data][name]'),'Dental floss · Unwaxed 50 m × 3');
  assert.equal(row(0,'[price_data][unit_amount]'),'712');
  assert.match(row(0,'[price_data][product_data][description]'),/Discount −S\$0\.38/);
  assert.equal(row(0,'[price_data][product_data][images][0]'),'https://cdn.example.invalid/floss.jpg');
  assert.equal(row(1,'[price_data][product_data][images][0]'),null);
  assert.equal(row(1,'[price_data][unit_amount]'),'238');
  assert.equal(row(2,'[price_data][product_data][name]'),'Singapore delivery');
  assert.equal(row(2,'[price_data][unit_amount]'),'390');
  assert.equal([0,1,2].reduce((total,i)=>total+Number(row(i,'[quantity]'))*Number(row(i,'[price_data][unit_amount]')),0),1340);
  assert.match(stripeForm.get('custom_text[submit][message]'),/CVM-1000\n\nOrder summary\n\nSubtotal S\$10\.00\n\nDelivery S\$3\.90\n\nDiscount −S\$0\.50\n\nTotal S\$13\.40/);
  assert.equal(stripeForm.get('customer_email'),'pay@example.invalid');
  assert.equal(stripeForm.get('metadata[order_id]'),orderId);assert.equal(stripeForm.has('total'),false);
  assert.deepEqual(attached,{p_user:userId,p_order:orderId,p_session:'cs_test_123'});
  member=account;
  assert.equal((await call('/api/checkout/session',{addressId})).status,201);
  assert.equal(stripeForm.get('customer_email'),account.email);
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

async function signedRequest(event,config=env){
 const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw));
 const signature=[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
 return new Request('https://cpvaluemart.com/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${timestamp},v1=${signature}`},body:raw});
}
test('a delayed signed payment uses the provider time to select the tier rollout',async()=>{
 const tierLaunch='2026-02-01T00:00:00Z';
 const settings={...env,STRIPE_SECRET_KEY:'sk_live_fixture',STRIPE_WEBHOOK_SECRET:'whsec_tier_fixture',
  STRIPE_CHECKOUT_MODE:'live',MEMBERSHIP_LAUNCH_AT:'2026-01-01T00:00:00Z',MEMBERSHIP_TIERS_LAUNCH_AT:tierLaunch};
 const event={id:'evt_tier_webhook',type:'checkout.session.completed',livemode:true,data:{object:{
  id:'cs_live_tier',metadata:{order_id:orderId},payment_status:'paid',payment_intent:'pi_tier',amount_total:10000,currency:'sgd'}}};
 const seen=[];
 await mocked(async(url,options)=>{
  seen.push([new URL(url).pathname.split('/').at(-1),JSON.parse(options.body)]);
  return Response.json({outcome:'paid'});
 },async()=>{
  const epoch=date=>Date.parse(date)/1000;
  for(const date of ['2026-01-31T23:59:59Z',tierLaunch]){
   const request=await signedRequest({...event,created:epoch(date)},settings);
   assert.equal((await worker.fetch(request,settings)).status,200);
  }
  assert.equal(seen[0][0],'apply_test_payment_event');
  assert.equal(seen[1][0],'apply_tier_payment_event');
  assert.equal(seen[1][1].p_paid_at,'2026-02-01T00:00:00.000Z');
  assert.equal(seen[1][1].p_amount,10000);
  assert.equal(seen[1][1].p_tiers_launch,tierLaunch);
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

test('bulk delivery requires an admin and accepts versioned orders without tracking overrides',async()=>{
 const path='/api/admin/orders/bulk-deliver', orders=[{orderId,version:2,tracking:'ignored'}];
 let isAdmin=false,stale=false,calls=0;
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  assert.match(String(url),/admin_bulk_deliver_orders$/);
  assert.deepEqual(JSON.parse(options.body),{p_actor:userId,p_orders:[{id:orderId,version:2}]});
  calls++;
  return stale?Response.json({code:'40001'},{status:400}):Response.json(1);
 },async()=>{
  assert.equal((await call(path,{orders})).status,403);
  isAdmin=true;
  assert.equal((await call(path,{orders},{origin:'https://example.invalid'})).status,403);
  assert.equal((await call(path,{orders:[...orders,...orders]})).status,400);
  const delivered=await call(path,{orders});
  assert.equal(delivered.status,200);
  assert.equal((await delivered.json()).delivered,1);
  stale=true;
  const conflict=await call(path,{orders});
  assert.equal(conflict.status,409);
  assert.equal((await conflict.json()).error.code,'VERSION_CONFLICT');
  assert.equal(calls,2);
 });
});

test('live checkout requires a compatible key and pilot access, and rejects a mismatched provider session',async()=>{
 const mode=env.STRIPE_CHECKOUT_MODE,secret=env.STRIPE_SECRET_KEY;
 env.STRIPE_CHECKOUT_MODE='live-pilot';
 let isAdmin=false,providerMode=false,created=0,released=0,attached=0;
 try{
  await mocked(async(url,options)=>{
   const path=new URL(url).pathname;
   if(path.endsWith('resolve_web_session'))return Response.json({account,isAdmin});
   if(path.endsWith('/orders'))return Response.json([]);
   if(path.endsWith('create_live_order')){created++;return Response.json({id:orderId,number:'CVM-2000',subtotal_cents:1000,shipping_cents:0,discount_cents:0,total_cents:1000,live_payment:true,items:[{product_name:'Soap',variant_name:'Classic',unit_cents:500,quantity:2}]});}
   if(path.endsWith('release_test_order')){released++;return Response.json(true);}
   if(path.endsWith('attach_test_checkout')){attached++;return Response.json(true);}
   assert.equal(path,'/v1/checkout/sessions');
   assert.equal(options.headers.Authorization,'Bearer rk_live_fake');
   return Response.json({id:'cs_live_fixture',url:'https://checkout.stripe.com/c/pay/cs_live_fixture',livemode:providerMode,amount_total:1000,currency:'sgd',client_reference_id:orderId});
  },async()=>{
   assert.equal((await call('/api/checkout/session',{addressId})).status,403);
   env.STRIPE_SECRET_KEY='rk_live_fake';
   assert.equal((await call('/api/checkout/session',{addressId})).status,403);
   isAdmin=true;
   assert.equal((await (await call('/api/checkout/session')).json()).available,true);
   assert.equal((await call('/api/checkout/session',{addressId})).status,503);
   providerMode=true;
   const response=await call('/api/checkout/session',{addressId});
   assert.equal(response.status,201);
   assert.equal((await response.json()).order.livePayment,true);
   assert.deepEqual([created,released,attached],[2,1,1]);
  });
 }finally{env.STRIPE_SECRET_KEY=secret;if(mode===undefined)delete env.STRIPE_CHECKOUT_MODE;else env.STRIPE_CHECKOUT_MODE=mode;}
});

test('checkout return resolves only the exact signed-in buyer session',async()=>{
 await mocked(async url=>{
  const link=new URL(url);
  if(link.pathname.endsWith('resolve_web_session'))return Response.json({account,isAdmin:false});
  assert.equal(link.searchParams.get('user_id'),'eq.'+userId);
  const session=link.searchParams.get('stripe_checkout_session_id');
  return Response.json(session==='eq.cs_live_owned'?[{id:orderId,order_number:2000,payment_status:'paid',live_payment:true}]:[]);
 },async()=>{
  assert.equal((await call('/api/checkout/status?session_id=cs_live_unowned')).status,404);
  assert.equal((await call('/api/checkout/status?session_id=cs_live_owned&session_id=cs_live_unowned')).status,404);
  const result=await (await call('/api/checkout/status?session_id=cs_live_owned')).json();
  assert.equal(result.orderNumber,'CVM-2000');assert.equal(result.paymentStatus,'paid');assert.equal(result.livePayment,true);
 });
});

test('formal member quote reserves the selected points and sends the immutable merchandise amounts to Stripe',async()=>{
 const launch='2026-01-01T00:00:00Z',settings={...env,STRIPE_CHECKOUT_MODE:'live',STRIPE_SECRET_KEY:'sk_live_fake',MEMBERSHIP_LAUNCH_AT:launch};
 const campaignId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const payload={memberCoupon:campaignId,points:200};
 const post=(path,data,mode=settings)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',headers:{
  Origin:'https://cpvaluemart.com',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(data)}),mode);
 const quoteInput={p_user:userId,p_launch:launch,p_live:true,p_member_coupon:campaignId,p_coupon:null,p_points:200};
 await mocked(async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(path.endsWith('/quote_points_checkout')){
   assert.deepEqual(JSON.parse(options.body),quoteInput);
   return Response.json({subtotal:5000,shipping:0,discount:500,couponDiscount:300,pointsDiscount:200,total:4500,maxPoints:470});
  }
  if(path.endsWith('/create_points_order')){
   assert.deepEqual(JSON.parse(options.body),{...quoteInput,p_address:addressId,p_expected_total:4500});
   return Response.json({id:orderId,number:'CVM-1000',subtotal_cents:5000,shipping_cents:0,discount_cents:500,total_cents:4500,
    member_points_redeemed:200,live_payment:true,items:[
      {sku:'A',product_name:'Product A',unit_cents:2000,quantity:1},
      {sku:'B',product_name:'Product B',unit_cents:3000,quantity:1}
    ],pricing:[
      {sku:'A',gross_cents:2000,cash_cents:1800,quantity:1,coupon_cents:120,point_cents:80},
      {sku:'B',gross_cents:3000,cash_cents:2700,quantity:1,coupon_cents:180,point_cents:120}
    ]});
  }
  if(path==='/v1/checkout/sessions'){
   const stripe=new URLSearchParams(options.body);
   assert.equal(stripe.get('line_items[0][price_data][unit_amount]'),'1800');
   assert.equal(stripe.get('line_items[1][price_data][unit_amount]'),'2700');
   assert.match(stripe.get('custom_text[submit][message]'),/Coupon −S\$3\.00[\s\S]*Points −S\$2\.00[\s\S]*Total S\$45\.00/);
   return Response.json({id:'cs_live_points',livemode:true,amount_total:4500,currency:'sgd',client_reference_id:orderId,
    url:'https://checkout.stripe.com/c/pay/points'});
  }
  if(path.endsWith('/attach_test_checkout'))return Response.json(true);
  throw Error('Unexpected request '+url);
 },async()=>{
  assert.equal((await (await post('/api/checkout/quote',{...payload,userId:addressId})).json()).pointsDiscount,200);
  assert.equal((await post('/api/checkout/session',{...payload,addressId,quotedTotal:4500})).status,201);
  assert.equal((await (await post('/api/checkout/quote',{points:99})).json()).error.code,'POINTS_MINIMUM');
  assert.equal((await (await post('/api/checkout/session',{...payload,addressId,quotedTotal:4500},{...env,MEMBERSHIP_LAUNCH_AT:launch})).json()).error.code,'POINTS_UNAVAILABLE');
 });
});

test('points are scoped to the signed-in member and admin adjustments use the verified actor',async()=>{
 const launch='2026-01-01T00:00:00Z',settings={...env,STRIPE_CHECKOUT_MODE:'live',MEMBERSHIP_LAUNCH_AT:launch};
 let admin=false;
 const balance={available:500,pending:45,expiring:0,ledger:[]};
 const request=(path,data)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:data?'POST':'GET',
  headers:{Origin:'https://cpvaluemart.com',Cookie:cookie,...(data?{'Content-Type':'application/json'}:{})},
  ...(data?{body:JSON.stringify(data)}:{})}),settings);
 await mocked(async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:admin});
  if(path.endsWith('/read_membership'))return Response.json({enabled:true,member:true,welcome:null});
  if(path.endsWith('/read_member_points')){
   assert.deepEqual(JSON.parse(options.body),{p_user:userId});
   return Response.json(balance);
  }
  if(path.endsWith('/read_admin_member_points')){
   assert.deepEqual(JSON.parse(options.body),{p_actor:userId,p_email:'customer@example.invalid'});
   return Response.json({accountId:addressId,points:balance});
  }
  if(path.endsWith('/adjust_member_points')){
   assert.deepEqual(JSON.parse(options.body),{p_actor:userId,p_user:addressId,p_points:-20,p_reason:'Duplicate award',p_request:orderId});
   return Response.json({...balance,available:480});
  }
  throw Error('Unexpected request '+url);
 },async()=>{
  const adminPath='/api/admin/membership/points';
  assert.equal((await (await request('/api/membership?userId='+addressId)).json()).points.available,500);
  assert.equal((await request(adminPath+'?email=customer@example.invalid')).status,403);
  admin=true;
  assert.equal((await (await request(adminPath+'?email=customer@example.invalid')).json()).accountId,addressId);
  const adjusted=await request(adminPath,{accountId:addressId,points:-20,reason:'Duplicate award',requestId:orderId,actorId:addressId});
  assert.equal((await adjusted.json()).points.available,480);
 });
});

test('member campaign administration authorizes the actor on every read and save',async()=>{
 const path='/api/admin/member-campaigns';
 const campaign={title:'Returning members',type:'fixed',amount:300,minimum:5000,
  startsAt:'2026-11-24T00:00:00.000Z',expiresAt:'2099-12-24T00:00:00.000Z',
  audience:'returning',memberLimit:1,totalLimit:20,active:true};
 let isAdmin=false;
 await mocked(async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  assert.equal(isAdmin,true);
  const input=JSON.parse(options.body);
  assert.equal(input.p_actor,userId);
  if(String(url).endsWith('/rpc/read_member_campaigns'))return Response.json([{...campaign,redeemed:5,testRedeemed:1}]);
  assert.match(String(url),/\/rpc\/save_member_campaign$/);
  assert.deepEqual(input,{p_actor:userId,p_id:null,p_version:0,p_campaign:campaign});
  return Response.json({...campaign,id:orderId,version:1,redeemed:0,testRedeemed:0});
 },async()=>{
  assert.equal((await call(path)).status,403);
  assert.equal((await call(path,campaign)).status,403);
  isAdmin=true;
  assert.equal((await (await call(path)).json()).campaigns[0].redeemed,5);
  assert.equal((await call(path,campaign,{origin:'https://unrelated.invalid'})).status,403);
  assert.equal((await call(path,{...campaign,memberLimit:21})).status,400);
  const saved=await call(path,{...campaign,actorId:addressId});
  assert.equal(saved.status,201);
  assert.equal((await saved.json()).campaign.version,1);
 });
});

test('a campaign coupon is quoted and reserved for the active account at the server total',async()=>{
 const launch='2026-11-24T00:00:00Z',campaignId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const session={id:'cs_test_campaign',livemode:false,amount_total:4700,currency:'sgd',client_reference_id:orderId,
  url:'https://checkout.stripe.com/c/pay/campaign'};
 const post=(path,body)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',
  headers:{Origin:'https://cpvaluemart.com',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}),{...env,MEMBERSHIP_LAUNCH_AT:launch});
 const campaignArgs={p_user:userId,p_campaign:campaignId,p_launch:launch,p_live:false};
 let denied=false;
 await mocked(async(url,options)=>{
  if(String(url).endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(String(url).endsWith('/quote_campaign_checkout')){
   assert.deepEqual(JSON.parse(options.body),campaignArgs);
   return denied?Response.json({message:'CAMPAIGN_UNAVAILABLE'},{status:409}):Response.json({subtotal:5000,shipping:0,discount:300,total:4700});
  }
  if(String(url).endsWith('/create_campaign_order')){
   assert.deepEqual(JSON.parse(options.body),{...campaignArgs,p_address:addressId,p_expected_total:4700});
   return Response.json({id:orderId,number:'CVM-1001',subtotal_cents:5000,shipping_cents:0,discount_cents:300,total_cents:4700,
    items:[{product_name:'Campaign product',unit_cents:5000,quantity:1}]});
  }
  if(String(url)==='https://api.stripe.com/v1/checkout/sessions'){
   assert.equal(options.body.get('line_items[0][price_data][unit_amount]'),'4700');
   return Response.json(session);
  }
  if(String(url).endsWith('/attach_test_checkout'))return Response.json(true);
  throw Error('Unexpected request '+url);
 },async()=>{
  const selected={memberCoupon:campaignId,userId:addressId,total:1};
  const quote=await post('/api/checkout/quote',selected);
  assert.equal((await quote.json()).total,4700);
  const created=await post('/api/checkout/session',{...selected,addressId,quotedTotal:4700});
  assert.equal(created.status,201);
  assert.equal((await created.json()).checkoutUrl,session.url);
  denied=true;
  const unavailable=await post('/api/checkout/quote',selected);
  assert.equal(unavailable.status,409);
  assert.equal((await unavailable.json()).error.code,'CAMPAIGN_UNAVAILABLE');
  assert.equal((await post('/api/checkout/quote',{...selected,coupon:'PUBLIC'})).status,400);
 });
});

test('annual delivery allowance quotes and charges final shipping for the current Sandbox account',async()=>{
 const launch='2020-01-01T00:00:00Z';
 const settings={...env,MEMBERSHIP_LAUNCH_AT:launch,MEMBERSHIP_TIERS_LAUNCH_AT:launch,PAID_MEMBERSHIP_LAUNCH_AT:launch};
 const token='77777777-7777-4777-8777-777777777777/0';
 const post=(path,payload,config=settings)=>worker.fetch(new Request('https://cpvaluemart.com'+path,{method:'POST',
  headers:{Origin:'https://cpvaluemart.com',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(payload)}),config);
 const selection={coupon:'PRODUCT',deliveryAllowance:true};
 const quoteInput={p_user:userId,p_launch:launch,p_live:false,p_member_coupon:null,p_coupon:'PRODUCT',p_points:0,p_use:true};
 const allowance={amount:390,discount:390,month:token,expiresAt:'2026-12-24T00:00:00Z'};
 await mocked(async(url,options)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/resolve_web_session'))return Response.json({account,isAdmin:false});
  if(path.endsWith('/quote_delivery_checkout')){
   assert.deepEqual(JSON.parse(options.body),quoteInput);
   return Response.json({subtotal:3200,shipping:110,discount:300,total:3010,deliveryAllowance:allowance});
  }
  if(path.endsWith('/create_delivery_order')){
   assert.deepEqual(JSON.parse(options.body),{...quoteInput,p_address:addressId,p_expected_total:3010,p_month:token});
   return Response.json({id:orderId,number:'CVM-1000',subtotal_cents:3200,shipping_cents:110,discount_cents:300,total_cents:3010,
    delivery_allowance_cents:390,items:[{product_name:'QA',unit_cents:3200,quantity:1}]});
  }
  if(path==='/v1/checkout/sessions'){
   const form=new URLSearchParams(options.body);
   assert.equal(form.get('line_items[0][price_data][unit_amount]'),'2900');
   assert.equal(form.get('line_items[1][price_data][unit_amount]'),'110');
   assert.match(form.get('custom_text[submit][message]'),/Annual pass delivery −S\$3\.90/);
   return Response.json({id:'cs_test_delivery',livemode:false,amount_total:3010,currency:'sgd',client_reference_id:orderId,
    url:'https://checkout.stripe.com/c/pay/delivery'});
  }
  if(path.endsWith('/attach_test_checkout'))return Response.json(true);
  throw Error('Unexpected request '+url);
 },async()=>{
  const quote=await post('/api/checkout/quote',{...selection,userId:addressId});
  assert.equal(quote.status,200);
  const {requestId,...quoted}=await quote.json();
  assert.ok(requestId);
  assert.deepEqual(quoted,{subtotal:3200,shipping:110,discount:300,total:3010,deliveryAllowance:allowance,accountId:userId});
  const created=await post('/api/checkout/session',{...selection,addressId,quotedTotal:3010,deliveryMonth:token,total:1});
  assert.equal(created.status,201);
  assert.equal((await created.json()).order.shipping,110);
  for(const value of [undefined,'2026-02-30T00:00:00Z','2099-01-01T00:00:00Z']){
   const closed={...settings,PAID_MEMBERSHIP_LAUNCH_AT:value};
   assert.equal((await (await post('/api/checkout/quote',selection,closed)).json()).error.code,'DELIVERY_ALLOWANCE_UNAVAILABLE');
   assert.equal((await (await post('/api/checkout/session',{...selection,addressId,quotedTotal:3010,deliveryMonth:token},closed)).json()).error.code,'DELIVERY_ALLOWANCE_UNAVAILABLE');
  }
 });
});
