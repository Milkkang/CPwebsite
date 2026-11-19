import { ApiError } from './catalog-api.mjs';
import { isAllowedOrigin, bodyJSON, db, identity } from './auth-api.mjs';

const encoder=new TextEncoder();
const safeId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const originGuard=request=>{
 if(!isAllowedOrigin(request))throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
};
const stripeConfig=env=>{
 if(typeof env.STRIPE_SECRET_KEY!=='string'||!env.STRIPE_SECRET_KEY.startsWith('sk_test_')||typeof env.STRIPE_WEBHOOK_SECRET!=='string'||!env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))
  throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Test checkout is temporarily unavailable.');
};
async function stripe(env,path,form) {
 stripeConfig(env);
 let response;
 try{response=await fetch('https://api.stripe.com/v1/'+path,{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded'},body:form});}
 catch{throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Test checkout is temporarily unavailable.');}
 let data;try{data=await response.json();}catch{throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Test checkout is temporarily unavailable.');}
 if(!response.ok)throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Test checkout is temporarily unavailable.');
 return data;
}
function orderShape(row){
 return {id:row.id,number:row.number,paymentStatus:row.payment_status,fulfilmentStatus:row.fulfilment_status,
  tracking:row.tracking_number,subtotal:row.subtotal_cents,shipping:row.shipping_cents,discount:row.discount_cents,total:row.total_cents,
  createdAt:row.created_at,paidAt:row.paid_at,items:(row.items??[]).map(item=>({sku:item.sku,name:item.product_name,option:item.variant_name,image:item.image_url,price:item.unit_cents,qty:item.quantity}))};
}
async function createSession(request,env){
 originGuard(request);stripeConfig(env);
 const who=await identity(request,env), data=await bodyJSON(request);
 if(!safeId(data.addressId)||data.coupon!==undefined&&(typeof data.coupon!=='string'||!/^[A-Z0-9_-]{0,40}$/.test(data.coupon)))
  throw new ApiError(400,'INVALID_INPUT','Choose a delivery address and check the coupon.');
 const created=await db(env,'rpc/create_test_order',{method:'POST',body:{p_user:who.account.id,p_address:data.addressId,p_coupon:data.coupon||null},allowFailure:true});
 if(!created.ok||!created.data?.id)throw new ApiError(409,created.data?.message==='ADDRESS_INVALID'?'ADDRESS_INVALID':'CART_CHANGED','Your basket, coupon or address changed. Refresh and try again.');
 const order=created.data;
 const form=new URLSearchParams({mode:'payment',success_url:'https://cpvaluemart.com/#/confirmation?session_id={CHECKOUT_SESSION_ID}',cancel_url:'https://cpvaluemart.com/#/checkout?cancelled=1',client_reference_id:order.id,
  'metadata[order_id]':order.id,'payment_intent_data[metadata][order_id]':order.id,
  'line_items[0][price_data][currency]':'sgd','line_items[0][price_data][unit_amount]':String(order.total_cents),
  'line_items[0][price_data][product_data][name]':'CP Value Mart test order '+order.number,'line_items[0][quantity]':'1',
  expires_at:String(Math.floor(Date.now()/1000)+3600)});
 let session;
 try{session=await stripe(env,'checkout/sessions',form);}
 catch(error){await db(env,'rpc/release_test_order',{method:'POST',body:{p_order:order.id},allowFailure:true});throw error;}
 if(session.livemode||!session.id||typeof session.url!=='string'||!session.url.startsWith('https://checkout.stripe.com/')){
  await db(env,'rpc/release_test_order',{method:'POST',body:{p_order:order.id},allowFailure:true});
  throw new ApiError(503,'CHECKOUT_UNAVAILABLE','Test checkout is temporarily unavailable.');
 }
 const attached=await db(env,'rpc/attach_test_checkout',{method:'POST',body:{p_user:who.account.id,p_order:order.id,p_session:session.id},allowFailure:true});
 if(!attached.ok||attached.data!==true)throw new ApiError(409,'ORDER_CHANGED','This test order is no longer available.');
 return {status:201,data:{order:orderShape(order),checkoutUrl:session.url,testMode:true}};
}
function hex(bytes){return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function verifyWebhook(request,env,raw){
 stripeConfig(env);const header=request.headers.get('Stripe-Signature')??'';
 const parts=Object.fromEntries(header.split(',').map(part=>part.split('=',2)));const timestamp=Number(parts.t),signature=parts.v1;
 if(!Number.isSafeInteger(timestamp)||Math.abs(Date.now()/1000-timestamp)>300||!/^[a-f0-9]{64}$/.test(signature??''))throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');
 const key=await crypto.subtle.importKey('raw',encoder.encode(env.STRIPE_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const expected=hex(await crypto.subtle.sign('HMAC',key,encoder.encode(parts.t+'.'+raw)));
 if(!equal(expected,signature))throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');
}
async function webhook(request,env){
 if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');
 const raw=await request.text();if(raw.length>262144)throw new ApiError(413,'REQUEST_TOO_LARGE','Webhook is too large.');
 await verifyWebhook(request,env,raw);let event;try{event=JSON.parse(raw);}catch{throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');}
 if(typeof event?.id!=='string'||typeof event?.type!=='string'||event.livemode!==false)throw new ApiError(400,'TEST_MODE_REQUIRED','Only Stripe test events are accepted.');
 const session=event.data?.object??{},orderId=session.metadata?.order_id;
 if(!safeId(orderId))return {status:200,data:{received:true,ignored:true}};
 const applied=await db(env,'rpc/apply_test_payment_event',{method:'POST',body:{p_event:event.id,p_type:event.type,p_livemode:event.livemode,p_order:orderId,p_session:String(session.id??''),p_intent:String(session.payment_intent??''),p_amount:Number(session.amount_total??-1),p_currency:String(session.currency??'')},allowFailure:true});
 if(!applied.ok)throw new ApiError(409,'PAYMENT_EVENT_REJECTED','Payment event was rejected.');
 return {status:200,data:{received:true}};
}
export const commerceRoute=path=>path==='/api/checkout/session'||path==='/api/orders'||path==='/api/stripe/webhook'||path==='/api/admin/orders';
export async function handleCommerce(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/api/stripe/webhook'){
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');return webhook(request,env);
 }
 if(path==='/api/checkout/session'){
  if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');return createSession(request,env);
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
 if(path==='/api/orders'){
  if(request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
  const who=await identity(request,env);const rows=await db(env,'orders?'+new URLSearchParams({select:'id,order_number,payment_status,fulfilment_status,tracking_number,subtotal_cents,shipping_cents,discount_cents,total_cents,created_at,paid_at,order_items(sku,product_name,variant_name,image_url,unit_cents,quantity)',user_id:'eq.'+who.account.id,order:'created_at.desc',limit:'100'}));
  return {status:200,data:{orders:rows.data.map(row=>orderShape({...row,number:'CVM-'+row.order_number,items:row.order_items}))}};
 }
 throw new ApiError(404,'NOT_FOUND','API endpoint not found.');
}
