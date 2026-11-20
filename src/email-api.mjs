import { ApiError } from './catalog-api.mjs';
import { isAllowedOrigin, bodyJSON, db, identity } from './auth-api.mjs';

const encoder=new TextEncoder();
const safeId=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=cents=>'S$'+(Number(cents)/100).toFixed(2);
const types=new Set(['email.delivered','email.bounced','email.complained','email.failed']);

function allowedRecipients(env){
 return new Set(String(env.TRANSACTIONAL_EMAIL_TEST_RECIPIENTS??'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));
}
function configReady(env){
 return typeof env.RESEND_API_KEY==='string'&&env.RESEND_API_KEY.startsWith('re_')&&
  typeof env.TRANSACTIONAL_EMAIL_FROM==='string'&&env.TRANSACTIONAL_EMAIL_FROM.includes('@')&&
  typeof env.TRANSACTIONAL_EMAIL_REPLY_TO==='string'&&env.TRANSACTIONAL_EMAIL_REPLY_TO.includes('@')&&allowedRecipients(env).size>0;
}
function template(job){
 const number=escape(job.payload?.orderNumber??'Test order'),total=money(job.payload?.total??0),tracking=escape(job.payload?.tracking??'');
 const content={
  order_confirmation:['Test order confirmed',`We received test order ${number}. Total: ${total}.`,`We received <strong>${number}</strong>. Test total: <strong>${total}</strong>.`],
  shipment:['Test order shipped',`Test order ${number} has shipped. Tracking: ${tracking}.`,`<strong>${number}</strong> has shipped. Tracking: <strong>${tracking}</strong>.`],
  delivery:['Test order delivered',`Test order ${number} has been marked as delivered.`,`<strong>${number}</strong> has been marked as delivered.`],
  cancellation:['Test order cancelled',`Test order ${number} was cancelled.`,`<strong>${number}</strong> was cancelled.`],
  test_refund:['Test refund recorded',`A Stripe sandbox refund was recorded for ${number}.`,`A Stripe sandbox refund was recorded for <strong>${number}</strong>.`]
 }[job.kind];
 if(!content)throw Error('UNKNOWN_EMAIL_KIND');
 return {subject:`[TEST ORDER] ${content[0]} · ${number}`,text:`CP Value Mart — TEST ORDER\n\n${content[1]}\n\nNo real payment or revenue is involved.`,
  html:`<!doctype html><html><body><h1>${content[0]}</h1><p>${content[2]}</p><p><strong>TEST ORDER:</strong> No real payment or revenue is involved.</p></body></html>`};
}
async function send(job,env){
 if(job.is_test!==true||!allowedRecipients(env).has(String(job.recipient).toLowerCase()))return {success:false,retryable:false,error:'RECIPIENT_NOT_ALLOWED'};
 let response;
 try{
  response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+env.RESEND_API_KEY,
   'Content-Type':'application/json','Idempotency-Key':job.idempotency_key},body:JSON.stringify({from:env.TRANSACTIONAL_EMAIL_FROM,to:[job.recipient],reply_to:env.TRANSACTIONAL_EMAIL_REPLY_TO,...template(job)})});
 }catch{return {success:false,retryable:true,error:'RESEND_NETWORK_ERROR'};}
 let data={};try{data=await response.json();}catch{}
 if(response.ok&&typeof data.id==='string')return {success:true,id:data.id};
 const retryable=response.status===408||response.status===409||response.status===429||response.status>=500;
 return {success:false,retryable,error:'RESEND_HTTP_'+response.status};
}
export async function processEmailJobs(env){
 if(!configReady(env))return {processed:0,configured:false};
 try{await db(env,'rpc/reconcile_email_confirmations',{method:'POST',body:{p_limit:25}});}catch{console.error('EMAIL_OUTBOX_RECONCILE_FAILED');}
 const claimed=await db(env,'rpc/claim_email_jobs',{method:'POST',body:{p_limit:10}}),jobs=Array.isArray(claimed.data)?claimed.data:[];
 for(const job of jobs){
  let result;try{result=await send(job,env);}catch{result={success:false,retryable:false,error:'EMAIL_TEMPLATE_ERROR'};}
  await db(env,'rpc/finish_email_attempt',{method:'POST',body:{p_job:job.id,p_attempt:job.attempt_count,p_success:result.success,
   p_provider_id:result.id??'',p_error:result.error??'',p_retryable:result.retryable??false}});
 }
 return {processed:jobs.length,configured:true};
}

function bytes(value){try{return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));}catch{return null;}}
function constantEqual(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;}
async function verify(request,env,raw){
 const id=request.headers.get('svix-id'),timestamp=request.headers.get('svix-timestamp'),header=request.headers.get('svix-signature');
 const time=Number(timestamp);if(!id||!Number.isSafeInteger(time)||Math.abs(Date.now()/1000-time)>300||!header)throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');
 const encoded=String(env.RESEND_WEBHOOK_SECRET??'').replace(/^whsec_/,'');const secret=bytes(encoded);
 if(!secret)throw new ApiError(503,'EMAIL_WEBHOOK_UNAVAILABLE','Email webhook is unavailable.');
 const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const expected=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(id+'.'+timestamp+'.'+raw)));
 const valid=header.split(' ').some(part=>{const [version,value]=part.split(',',2),actual=bytes(value??'');return version==='v1'&&actual&&constantEqual(expected,actual);});
 if(!valid)throw new ApiError(400,'INVALID_SIGNATURE','Invalid webhook signature.');return id;
}
async function webhook(request,env){
 if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');
 const raw=await request.text();if(raw.length>262144)throw new ApiError(413,'REQUEST_TOO_LARGE','Webhook is too large.');
 const eventId=await verify(request,env,raw);let event;try{event=JSON.parse(raw);}catch{throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');}
 if(!types.has(event?.type))return {status:200,data:{received:true,ignored:true}};
 const message=event.data?.email_id;if(typeof message!=='string'||message.length>200)throw new ApiError(400,'INVALID_WEBHOOK','Invalid webhook.');
 const applied=await db(env,'rpc/apply_email_delivery_event',{method:'POST',body:{p_event:eventId,p_message:message,p_type:event.type},allowFailure:true});
 if(!applied.ok)throw new ApiError(503,'EMAIL_EVENT_UNAVAILABLE','Email event could not be recorded.');
 return {status:200,data:{received:true}};
}
async function admin(request,env){
 const who=await identity(request,env);if(!who.isAdmin)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
 if(request.method==='GET'){
  const rows=await db(env,'rpc/read_admin_email_jobs',{method:'POST',body:{p_actor:who.account.id}});return {status:200,data:{jobs:rows.data}};
 }
 if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(!isAllowedOrigin(request))throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
 const data=await bodyJSON(request);if(data.action!=='resend'||!safeId(data.jobId))throw new ApiError(400,'INVALID_INPUT','Choose an eligible failed email.');
 const result=await db(env,'rpc/admin_resend_email',{method:'POST',body:{p_actor:who.account.id,p_job:data.jobId},allowFailure:true});
 if(!result.ok||!safeId(result.data))throw new ApiError(409,'RESEND_NOT_ALLOWED','This email cannot be resent.');
 return {status:202,data:{queued:true}};
}
export const emailRoute=path=>path==='/api/resend/webhook'||path==='/api/admin/email-jobs';
export async function handleEmail(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/api/resend/webhook')return webhook(request,env);
 if(path==='/api/admin/email-jobs')return admin(request,env);
 throw new ApiError(404,'NOT_FOUND','API endpoint not found.');
}
