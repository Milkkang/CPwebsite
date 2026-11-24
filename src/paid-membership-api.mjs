import { ApiError } from './catalog-api.mjs';
import { bodyJSON, db, identity, isAllowedOrigin } from './auth-api.mjs';

const endpoint='/api/membership/annual';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const fee=1990;

function launchEnabled(env){
 const value=env.PAID_MEMBERSHIP_LAUNCH_AT;
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value))return false;
 const date=new Date(value);
 return Number.isFinite(date.getTime())&&date.toISOString()===value.replace('Z','.000Z')&&date.getTime()<=Date.now();
}

export async function handlePaidMembership(request,env,{checkoutAvailable,stripeReady,liveMode,stripe,stripeRead}){
 if(!['GET','POST'].includes(request.method))throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(request.method==='POST'&&!isAllowedOrigin(request))throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
 const who=await identity(request,env);
 const owner=who.account.id;
 const live=liveMode(env);
 const enabled=launchEnabled(env)&&who.account.verified===true;
 if(request.method==='GET'){
  if(!enabled)return {status:200,data:{enabled:false,accountId:owner}};
  const purchases=new URL(request.url).searchParams.getAll('purchase_id');
  if(purchases.length>1||purchases.length===1&&!uuid.test(purchases[0]))throw new ApiError(400,'INVALID_PURCHASE','Invalid annual pass reference.');
  const {data}=await db(env,'rpc/read_paid_membership',{method:'POST',
   body:{p_user:owner,p_livemode:live,p_purchase:purchases[0]??null}});
  if(purchases.length&&!data.purchaseStatus)throw new ApiError(404,'PURCHASE_NOT_FOUND','This annual pass purchase is unavailable.');
  return {status:200,data:{...data,enabled:true,available:stripeReady(env)&&await checkoutAvailable(who,env),
   accountId:owner,fee,termMonths:12,testMode:!live}};
 }
 if(!enabled||!stripeReady(env)||!await checkoutAvailable(who,env))
  throw new ApiError(403,'ANNUAL_PASS_UNAVAILABLE','Annual pass checkout is unavailable.');
 const data=await bodyJSON(request);
 if(data.acceptTerms!==true)throw new ApiError(400,'ANNUAL_PASS_TERMS_REQUIRED','Review and accept the annual pass terms.');
 return createCheckout(request,env,{owner,live,stripe,stripeRead});
}

export const paidMembershipRoute=path=>path===endpoint;

const recordsPurchase=(id,live)=>typeof id==='string'&&
 (live?/^cs_live_[A-Za-z0-9_]{1,200}$/:/^cs_test_[A-Za-z0-9_]{1,200}$/).test(id);
const allowedOrigin=value=>{
 try{return isAllowedOrigin(new Request(value,{headers:{Origin:value}}));}catch{return false;}
};
function validSession(session,purchase,owner,live){
 return session?.object==='checkout.session'&&recordsPurchase(session.id,live)&&session.livemode===live&&
  session.mode==='payment'&&session.currency==='sgd'&&session.amount_total===fee&&
  session.client_reference_id===purchase&&session.metadata?.paid_membership_purchase_id===purchase&&
  session.metadata?.paid_membership_user_id===owner;
}
const unavailable=()=>new ApiError(503,'ANNUAL_PASS_UNAVAILABLE','Annual pass checkout is temporarily unavailable.');
function checkoutForm(purchase,owner,live){
 const back=purchase.origin+'/#/account?purchase_id='+purchase.id;
 return new URLSearchParams({
  mode:'payment',success_url:back+'&annual=return',cancel_url:back+'&annual=cancel',
  client_reference_id:purchase.id,expires_at:String(purchase.expiresAt),'adaptive_pricing[enabled]':'false',
  'metadata[paid_membership_purchase_id]':purchase.id,'metadata[paid_membership_user_id]':owner,
  'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'sgd',
  'line_items[0][price_data][unit_amount]':String(fee),
  'line_items[0][price_data][product_data][name]':(live?'':'TEST PAYMENT · ')+'CP Value Mart Annual Pass',
  'line_items[0][price_data][product_data][description]':'12 months · Manual renewal',
  'custom_text[submit][message]':'One-time annual fee. We do not offer voluntary refunds. Your statutory rights apply.',
  'branding_settings[background_color]':'#f5f6f3','branding_settings[button_color]':'#264d3c',
  'branding_settings[border_style]':'rounded','branding_settings[font_family]':'inter'
 });
}
async function createCheckout(request,env,{owner,live,stripe,stripeRead}){
 const rpcBody={p_user:owner,p_livemode:live};
 const origin=new URL(request.url).origin;
 for(let attempt=0;attempt<2;attempt++){
  const {ok,data:purchase}=await db(env,'rpc/prepare_paid_membership_checkout',{method:'POST',
   body:{...rpcBody,p_origin:origin},allowFailure:true});
  if(!ok){
   if(purchase?.message==='ANNUAL_PASS_NOT_RENEWABLE')
    throw new ApiError(409,'ANNUAL_PASS_NOT_RENEWABLE','You can renew within 30 days of your annual pass expiry.');
   throw unavailable();
  }
  if(!uuid.test(purchase?.id??'')||!allowedOrigin(purchase.origin)||!Number.isSafeInteger(purchase.expiresAt))
   throw unavailable();
  if(purchase.sessionId&&!recordsPurchase(purchase.sessionId,live))throw unavailable();
  const session=purchase.sessionId
   ?await stripeRead(env,'checkout/sessions/'+encodeURIComponent(purchase.sessionId))
   :await stripe(env,'checkout/sessions',checkoutForm(purchase,owner,live),'annual-membership/'+purchase.id);
  if(!validSession(session,purchase.id,owner,live)||purchase.sessionId&&purchase.sessionId!==session.id)throw unavailable();
  const binding={...rpcBody,p_purchase:purchase.id,p_session:session.id};
  if(session.status==='expired'&&session.payment_status==='unpaid'){
   const expired=await db(env,'rpc/expire_paid_membership_checkout',{method:'POST',body:binding});
   if(expired.data!==true)throw unavailable();
   continue;
  }
  if(session.status==='complete')return {status:200,data:{accountId:owner,pending:true,purchaseId:purchase.id}};
  if(session.status!=='open'||typeof session.url!=='string'||!session.url.startsWith('https://checkout.stripe.com/'))throw unavailable();
  if(!purchase.sessionId){
   const attached=await db(env,'rpc/attach_paid_membership_checkout',{method:'POST',body:binding});
   if(attached.data!==true)throw unavailable();
  }
  return {status:201,data:{accountId:owner,checkoutUrl:session.url,testMode:!live}};
 }
 throw unavailable();
}

const rejected=()=>new ApiError(409,'PAYMENT_EVENT_REJECTED','Payment event was rejected.');
export async function applyPaidMembershipEvent(env,event,session){
 const purchase=session.metadata?.paid_membership_purchase_id;
 const owner=session.metadata?.paid_membership_user_id;
 if(!uuid.test(purchase??'')||!uuid.test(owner??'')||!validSession(session,purchase,owner,event.livemode)||
   !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id)||!Number.isSafeInteger(event.created)||event.created<=0||
   event.created>Math.floor(Date.now()/1000)+300)throw rejected();
 const expired=event.type==='checkout.session.expired';
 const failed=event.type==='checkout.session.async_payment_failed';
 const success=!expired&&!failed;
 if(success&&session.payment_status!=='paid')return {status:200,data:{received:true,ignored:true}};
 if(session.status!==(expired?'expired':'complete')||
  (success?!/^pi_[A-Za-z0-9_]{1,200}$/.test(session.payment_intent??''):session.payment_status!=='unpaid'))throw rejected();
 const {ok}=await db(env,'rpc/apply_paid_membership_event',{method:'POST',allowFailure:true,body:{
  p_event:event.id,p_type:event.type,p_livemode:event.livemode,p_purchase:purchase,p_user:owner,
  p_session:session.id,p_intent:success?session.payment_intent:null,p_amount:session.amount_total,
  p_currency:session.currency,p_event_at:new Date(event.created*1000).toISOString()
 }});
 if(!ok)throw rejected();
 return {status:200,data:{received:true}};
}
