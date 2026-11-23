import { ApiError } from './catalog-api.mjs';
import { isAllowedOrigin, bodyJSON, bodyText, db, identity } from './auth-api.mjs';

const encoder=new TextEncoder();
const orderUuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const safeId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const originGuard=request=>{
 if(!isAllowedOrigin(request))throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
};
const checkoutMode=env=>env.STRIPE_CHECKOUT_MODE??'sandbox';
const liveMode=env=>['live-pilot','live'].includes(checkoutMode(env));
const sessionPattern=live=>live?/^cs_live_[A-Za-z0-9_]{1,200}$/:/^cs_test_[A-Za-z0-9_]{1,200}$/;
const stripeReady=env=>{
 const mode=checkoutMode(env);
 const secret=String(env.STRIPE_SECRET_KEY??'');
 return (mode==='sandbox'?/^(sk|rk)_test_/.test(secret):
  liveMode(env)&&/^(sk|rk)_live_/.test(secret))&&String(env.STRIPE_WEBHOOK_SECRET??'').startsWith('whsec_');
};
const stripeConfig=env=>{
 if(!stripeReady(env))throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Checkout is temporarily unavailable.');
};
async function stripe(env,path,form,idempotencyKey) {
 stripeConfig(env);
 let response;
 try{response=await fetch('https://api.stripe.com/v1/'+path,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:form});}
 catch{console.error(JSON.stringify({event:'STRIPE_NETWORK_ERROR'}));throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Checkout is temporarily unavailable.');}
 let data;try{data=await response.json();}catch{throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Checkout is temporarily unavailable.');}
 if(!response.ok){const code=String(data?.error?.code??data?.error?.type??'unknown');console.error(JSON.stringify({event:'STRIPE_REQUEST_REJECTED',status:response.status,code:/^[a-z_]{1,80}$/.test(code)?code:'unknown'}));throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Checkout is temporarily unavailable.');}
 return data;
}
async function stripeRead(env,path){
 stripeConfig(env);
 try{const response=await fetch('https://api.stripe.com/v1/'+path,{signal:AbortSignal.timeout(10000),redirect:'manual',headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY}});
  if(response.ok)return await response.json();
 }catch{}
 throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Payment service is temporarily unavailable.');
}
function orderShape(row){
 return {id:row.id,number:row.number,version:row.version,paymentStatus:row.payment_status,fulfilmentStatus:row.fulfilment_status,
  tracking:row.tracking_number,subtotal:row.subtotal_cents,shipping:row.shipping_cents,discount:row.discount_cents,total:row.total_cents,
  createdAt:row.created_at,paidAt:row.paid_at,livePayment:row.live_payment===true,items:(row.items??[]).map(item=>({sku:item.sku,name:item.product_name,option:item.variant_name,image:item.image_url,price:item.unit_cents,qty:item.quantity}))};
}
async function canUsePreviewCheckout(who,env){
 if(!who.account.verified)return false;
 const allowed=String(env.TRANSACTIONAL_EMAIL_TEST_RECIPIENTS??'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
 if(allowed.includes(String(who.account.email).toLowerCase()))return true;
 const access=await db(env,'rpc/is_checkout_tester',{method:'POST',body:{p_user:who.account.id}});
 return access.data===true;
}
async function checkoutAvailable(who,env){
 if(!who.account.verified)return false;
 if(checkoutMode(env)==='sandbox')return canUsePreviewCheckout(who,env);
 return stripeReady(env)&&(checkoutMode(env)==='live'||(checkoutMode(env)==='live-pilot'&&who.isAdmin===true));
}
async function createSession(request,env){
 originGuard(request);
 const who=await identity(request,env);
 if(!await checkoutAvailable(who,env))throw new ApiError(403,'TEST_CHECKOUT_RESTRICTED','Online ordering is currently unavailable.');
 stripeConfig(env);
 const live=liveMode(env);
 const data=await bodyJSON(request);
 if(!safeId(data.addressId)||data.coupon!==undefined&&(typeof data.coupon!=='string'||!/^[A-Z0-9_-]{0,40}$/.test(data.coupon)))
  throw new ApiError(400,'INVALID_INPUT','Choose a delivery address and check the coupon.');
 const created=await db(env,live?'rpc/create_live_order':'rpc/create_test_order',{method:'POST',body:{p_user:who.account.id,p_address:data.addressId,p_coupon:data.coupon||null},allowFailure:true});
 if(!created.ok&&created.data?.message==='CHECKOUT_PENDING')throw new ApiError(409,'CHECKOUT_PENDING','A checkout is still open. Complete or cancel it before starting a new one.');
 if(!created.ok||!created.data?.id)throw new ApiError(409,created.data?.message==='ADDRESS_INVALID'?'ADDRESS_INVALID':'CART_CHANGED','Your basket, coupon or address changed. Refresh and try again.');
 const order=created.data;
 const form=new URLSearchParams({mode:'payment',success_url:'https://cpvaluemart.com/#/confirmation?session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://cpvaluemart.com/#/checkout?cancelled=1',client_reference_id:order.id,
  customer_email:who.account.checkoutEmail||who.account.email,
  'metadata[order_id]':order.id,'payment_intent_data[metadata][order_id]':order.id,
  'line_items[0][price_data][currency]':'sgd','line_items[0][price_data][unit_amount]':String(order.total_cents),
  'line_items[0][price_data][product_data][name]':'CP Value Mart · '+(live?'Order ':'Simulated order ')+order.number,'line_items[0][quantity]':'1',
  expires_at:String(Math.floor(Date.now()/1000)+3600)});
 let session;
 try{session=await stripe(env,'checkout/sessions',form,'checkout/'+order.id);}
 catch(error){await db(env,'rpc/release_test_order',{method:'POST',body:{p_order:order.id},allowFailure:true});throw error;}
 if(session.livemode!==live||!sessionPattern(live).test(session.id??'')||
   live&&(session.amount_total!==order.total_cents||session.currency!=='sgd'||session.client_reference_id!==order.id)||
   typeof session.url!=='string'||!session.url.startsWith('https://checkout.stripe.com/')){
  await db(env,'rpc/release_test_order',{method:'POST',body:{p_order:order.id},allowFailure:true});
  throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Checkout is temporarily unavailable.');
 }
 const attached=await db(env,'rpc/attach_test_checkout',{method:'POST',body:{p_user:who.account.id,p_order:order.id,p_session:session.id},allowFailure:true});
 if(!attached.ok||attached.data!==true){
  if(live){
   const expired=await stripe(env,'checkout/sessions/'+encodeURIComponent(session.id)+'/expire',new URLSearchParams(),'abandoned/'+order.id);
   if(expired.id===session.id&&expired.status==='expired'&&expired.livemode===true){
    await db(env,'rpc/release_test_order',{method:'POST',body:{p_order:order.id},allowFailure:true});
   }
  }
  throw new ApiError(409,'ORDER_CHANGED','This order is no longer available.');
 }
 return {status:201,data:{order:orderShape(order),checkoutUrl:session.url,testMode:!live}};
}
async function getPendingLiveOrder(who,env){
 const {data}=await db(env,'orders?'+new URLSearchParams({select:'id,stripe_checkout_session_id',
  user_id:'eq.'+who.account.id,live_payment:'eq.true',payment_status:'eq.pending',limit:'1'}));
 return data[0];
}
async function manageCheckout(request,env){
 if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 originGuard(request);
 const who=await identity(request,env);
 if(!liveMode(env)||!await checkoutAvailable(who,env))throw new ApiError(403,'CHECKOUT_UNAVAILABLE','Checkout is unavailable.');
 const order=await getPendingLiveOrder(who,env);
 if(!order||!sessionPattern(true).test(order.stripe_checkout_session_id??''))throw new ApiError(409,'CHECKOUT_NOT_FOUND','No open checkout was found.');
 const {action}=await bodyJSON(request);
 if(!['resume','cancel'].includes(action))throw new ApiError(400,'INVALID_INPUT','Choose a valid checkout action.');
 const sessionId=order.stripe_checkout_session_id;
 const path='checkout/sessions/'+encodeURIComponent(sessionId);
 const owned=session=>session.livemode===true&&session.id===sessionId&&session.metadata?.order_id===order.id;
 let session=await stripeRead(env,path);
 if(!owned(session))throw new ApiError(409,'ORDER_CHANGED','Checkout could not be verified.');
 if(action==='resume'&&session.status==='open'&&typeof session.url==='string'&&session.url.startsWith('https://checkout.stripe.com/')){
  return {status:200,data:{checkoutUrl:session.url}};
 }
 if(action==='cancel'){
  if(session.status==='open')session=await stripe(env,path+'/expire',new URLSearchParams(),'cancel/'+order.id);
  if(owned(session)&&session.status==='expired'){
   const result=await db(env,'rpc/cancel_live_checkout',{method:'POST',body:{p_user:who.account.id,p_order:order.id,p_session:sessionId}});
   if(result.data===true)return {status:200,data:{cancelled:true}};
  }
 }
 throw new ApiError(409,'ORDER_CHANGED','This checkout is no longer open. Check your order history for the latest status.');
}
async function readCheckoutStatus(request,env){
 const who=await identity(request,env);
 const sessions=new URL(request.url).searchParams.getAll('session_id');
 const unavailable=()=>new ApiError(404,'CHECKOUT_NOT_FOUND','This checkout is unavailable.');
 if(sessions.length!==1||!/^cs_(?:live|test)_[A-Za-z0-9_]{1,200}$/.test(sessions[0]))throw unavailable();
 const {data}=await db(env,'orders?'+new URLSearchParams({select:'id,order_number,payment_status,live_payment',
  user_id:'eq.'+who.account.id,stripe_checkout_session_id:'eq.'+sessions[0],limit:'1'}));
 const row=data[0];
 if(!row)throw unavailable();
 return {status:200,data:{orderId:row.id,orderNumber:'CVM-'+row.order_number,paymentStatus:row.payment_status,livePayment:row.live_payment===true}};
}
function hex(bytes){return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function verifyWebhook(request,env,raw){
 stripeConfig(env);const header=request.headers.get('Stripe-Signature')??'';
 const parts=header.split(',').map(part=>part.trim().split('=',2));
 const signedAt=parts.find(([name])=>name==='t')?.[1];
 const timestamp=Number(signedAt),signatures=parts.filter(([name,value])=>name==='v1'&&/^[a-f0-9]{64}$/.test(value??''));
 if(!Number.isSafeInteger(timestamp)||Math.abs(Date.now()/1000-timestamp)>300||!signatures.length)throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');
 const key=await crypto.subtle.importKey('raw',encoder.encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const expected=hex(await crypto.subtle.sign('HMAC',key,encoder.encode(signedAt+'.'+raw)));
 if(!signatures.some(([,signature])=>equal(expected,signature)))throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');
}
async function webhook(request,env){
 if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');
 const raw=await bodyText(request,262144);
 await verifyWebhook(request,env,raw);let event;try{event=JSON.parse(raw);}catch{throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');}
 if(typeof event?.id!=='string'||typeof event?.type!=='string'||event.livemode!==liveMode(env))throw new ApiError(400,'TEST_MODE_REQUIRED','Stripe event mode is invalid.');
 const session=event.data?.object??{},orderId=session.metadata?.order_id;
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type))return {status:200,data:{received:true,ignored:true}};
 if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&session.payment_status!=='paid')return {status:200,data:{received:true,ignored:true}};
 if(!safeId(orderId))return {status:200,data:{received:true,ignored:true}};
 const applied=await db(env,'rpc/apply_test_payment_event',{method:'POST',body:{p_event:event.id,p_type:event.type,p_livemode:event.livemode,p_order:orderId,p_session:String(session.id??''),p_intent:String(session.payment_intent??''),p_amount:Number(session.amount_total??-1),p_currency:String(session.currency??'')},allowFailure:true});
 if(!applied.ok)throw new ApiError(409,'PAYMENT_EVENT_REJECTED','Payment event was rejected.');
 return {status:200,data:{received:true}};
}
export const commerceRoute=path=>path==='/api/checkout/session'||path==='/api/checkout/status'||path==='/api/checkout/manage'||path==='/api/orders'||path==='/api/orders/receipt'||path==='/api/stripe/webhook'||path==='/api/admin/orders'||path==='/api/admin/orders/bulk-ship'||path==='/api/admin/orders/bulk-deliver'||path==='/api/admin/order-actions';
export async function handleCommerce(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/api/stripe/webhook'){
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');return webhook(request,env);
 }
 if(path==='/api/checkout/manage')return manageCheckout(request,env);
 if(path==='/api/checkout/status'){
  if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  return readCheckoutStatus(request,env);
 }
 if(path==='/api/checkout/session'){
  if(request.method==='GET'){
   const who=await identity(request,env);
   const available=await checkoutAvailable(who,env),livePayment=liveMode(env);
   const pending=available&&livePayment?await getPendingLiveOrder(who,env):null;
   return {status:200,data:{available,livePayment,pending:Boolean(pending?.stripe_checkout_session_id)}};
  }
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');return createSession(request,env);
 }
 if(path==='/api/admin/order-actions'){
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  originGuard(request);
  const who=await identity(request,env);if(!who.isAdmin)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
  stripeConfig(env);const live=liveMode(env),data=await bodyJSON(request);
  if(!safeId(data.orderId)||!Number.isSafeInteger(data.version)||data.version<1||!['cancel','refund'].includes(data.action)||typeof data.restock!=='boolean')throw new ApiError(400,'INVALID_INPUT','Check the order operation.');
  const prepared=await db(env,'rpc/prepare_order_operation',{method:'POST',body:{p_actor:who.account.id,p_order:data.orderId,p_version:data.version,p_action:data.action,p_restock:data.restock,p_live:live},allowFailure:true});
  if(!prepared.ok){
   if(prepared.data?.message==='PAYMENT_MODE_MISMATCH')throw new ApiError(409,'PAYMENT_MODE_MISMATCH','Payment actions are unavailable for this order in the current checkout mode.');
   throw new ApiError(409,'ORDER_CHANGED','This order changed or the operation is unavailable. Reload before retrying.');
  }
  const op=prepared.data;
  if(!op.completed){
   let provider;
   if(data.action==='refund'){
    if(!/^pi_[A-Za-z0-9_]+$/.test(op.intent??''))throw new ApiError(409,'INVALID_ORDER','Payment reference is unavailable.');
    const intent=await stripeRead(env,'payment_intents/'+encodeURIComponent(op.intent));
    if(intent.livemode!==live||intent.id!==op.intent||intent.currency!==op.currency||intent.amount!==op.amount||intent.metadata?.order_id!==data.orderId)throw new ApiError(409,'PAYMENT_UNVERIFIED','The payment could not be verified.');
    const existing=await stripeRead(env,'refunds?'+new URLSearchParams({payment_intent:op.intent,limit:'100'}));
    if(!Array.isArray(existing.data))throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Refunds are unavailable.');
    const prior=existing.data.filter(refund=>refund.metadata?.order_id===data.orderId);
    if(prior.length>1)throw new ApiError(409,'REFUND_UNVERIFIED','Refund reconciliation requires administrator review.');
    const refund=prior[0]??await stripe(env,'refunds',new URLSearchParams({payment_intent:op.intent,amount:String(op.amount),'metadata[order_id]':data.orderId}),'refund/'+data.orderId);
    if((live&&refund.livemode!==true)||refund.payment_intent!==op.intent||refund.amount!==op.amount||refund.currency!==op.currency||!/^re_/.test(refund.id??''))throw new ApiError(409,'REFUND_UNVERIFIED','The refund could not be verified. Retry this same operation.');
    if(refund.status!=='succeeded')throw new ApiError(409,'REFUND_PENDING','The refund is not complete. Retry this same operation later.');
    provider=refund.id;
   }else{
    if(!sessionPattern(live).test(op.session??''))throw new ApiError(409,'INVALID_ORDER','Checkout reference is unavailable.');
    // Retrieve first: an expired session can be retried after a lost response.
    let session=await stripeRead(env,'checkout/sessions/'+encodeURIComponent(op.session));
    if(session.status==='open')session=await stripe(env,'checkout/sessions/'+encodeURIComponent(op.session)+'/expire',new URLSearchParams(),'cancel/'+data.orderId);
    if(session.livemode===live&&session.id===op.session&&session.status==='complete')await db(env,'rpc/finish_test_order_operation',{method:'POST',body:{p_actor:who.account.id,p_order:data.orderId,p_action:data.action,p_provider:'checkout_completed'}});
    if(session.livemode!==live||session.id!==op.session||session.status!=='expired')throw new ApiError(409,'ORDER_CHANGED','Checkout cannot be cancelled. Reconcile its payment first.');
    provider=session.id;
   }
   const finished=await db(env,'rpc/finish_test_order_operation',{method:'POST',body:{p_actor:who.account.id,p_order:data.orderId,p_action:data.action,p_provider:provider},allowFailure:true});
   if(!finished.ok||finished.data!==true)throw new ApiError(409,'OPERATION_PENDING','Provider operation recorded. Retry the same action to reconcile the order.');
  }
  return {status:200,data:{ok:true,testMode:!live}};
 }
 if(path==='/api/admin/orders/bulk-ship'||path==='/api/admin/orders/bulk-deliver'){
  const shipping=path.endsWith('bulk-ship');
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  originGuard(request);
  const who=await identity(request,env);
  if(!who.isAdmin)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
  const {orders}=await bodyJSON(request,96*1024);
  if(!Array.isArray(orders)||orders.length<1||orders.length>100||orders.some(order=>
   !order||typeof order.orderId!=='string'||!orderUuid.test(order.orderId)||!Number.isInteger(order.version)||
   order.version<1||order.version>2147483647||shipping&&(typeof order.tracking!=='string'||!order.tracking.trim()||
   order.tracking.length>120||/[\x00-\x1f\x7f]/.test(order.tracking))
  )||new Set(orders.map(order=>order.orderId.toLowerCase())).size!==orders.length){
   throw new ApiError(400,'INVALID_INPUT',shipping?'Select up to 100 distinct orders and enter a tracking number for each.':'Select up to 100 distinct shipped orders.');
  }
  const changed=await db(env,shipping?'rpc/admin_bulk_ship_orders':'rpc/admin_bulk_deliver_orders',{method:'POST',body:{
   p_actor:who.account.id,p_orders:orders.map(order=>({id:order.orderId,version:order.version,...(shipping?{tracking:order.tracking.trim()}:{})}))
  },allowFailure:true});
  if(!changed.ok){
   if(changed.data?.code==='40001')throw new ApiError(409,'VERSION_CONFLICT','An order changed. Select the latest orders and try again.');
   if(changed.data?.code==='42501')throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
   throw new ApiError(503,shipping?'SHIPMENT_UNAVAILABLE':'DELIVERY_UNAVAILABLE','Could not update the orders. Refresh the order list before trying again.');
  }
  return {status:200,data:{[shipping?'shipped':'delivered']:changed.data}};
 }
 if(path==='/api/admin/orders'){
  if(!['GET','POST'].includes(request.method))throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  if(request.method==='POST')originGuard(request);
  const who=await identity(request,env);if(!who.isAdmin)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
  if(request.method==='POST'){
   const data=await bodyJSON(request);
   if(!safeId(data.orderId)||!Number.isSafeInteger(data.version)||data.version<1||!['Processing','Shipped','Delivered'].includes(data.status)||typeof data.tracking!=='string'||data.tracking.length>120)
    throw new ApiError(400,'INVALID_INPUT','Check the fulfilment fields.');
   const changed=await db(env,'rpc/admin_update_order',{method:'POST',body:{p_actor:who.account.id,p_order:data.orderId,p_version:data.version,p_status:data.status,p_tracking:data.tracking},allowFailure:true});
   if(!changed.ok)throw new ApiError(changed.data?.code==='40001'?409:400,changed.data?.code==='40001'?'VERSION_CONFLICT':'INVALID_ORDER','This order changed or the fulfilment update is invalid.');
  }
  const rows=await db(env,'rpc/read_admin_orders',{method:'POST',body:{p_actor:who.account.id}});
  return {status:200,data:{orders:rows.data.map(row=>({...orderShape({...row,number:row.number,items:row.items}),version:row.version,email:row.email,name:row.customer_name,address:{name:row.full_name,line:row.address_line,postal:row.postal_code}}))}};
 }
 if(path==='/api/orders/receipt'){
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');originGuard(request);
  const who=await identity(request,env),data=await bodyJSON(request);
  if(!safeId(data.orderId)||!Number.isSafeInteger(data.version)||data.version<1)throw new ApiError(400,'INVALID_INPUT','Invalid order.');
  const r=await db(env,'rpc/confirm_test_order_receipt',{method:'POST',body:{p_user:who.account.id,p_order:data.orderId,p_version:data.version},allowFailure:true});
  if(!r.ok||r.data!==true)throw new ApiError(409,'ORDER_CHANGED','Order unavailable or changed. Refresh before confirming receipt.');
  return {status:200,data:{ok:true}};
 }
 if(path==='/api/orders'){
  if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  const who=await identity(request,env);const rows=await db(env,'orders?'+new URLSearchParams({select:'id,order_number,live_payment,payment_status,fulfilment_status,tracking_number,version,subtotal_cents,shipping_cents,discount_cents,total_cents,created_at,paid_at,order_items(sku,product_name,variant_name,image_url,unit_cents,quantity)',user_id:'eq.'+who.account.id,order:'created_at.desc',limit:'100'}));
  return {status:200,data:{orders:rows.data.map(row=>orderShape({...row,number:'CVM-'+row.order_number,items:row.order_items}))}};
 }
 throw new ApiError(404,'NOT_FOUND','API endpoint not found.');
}
