import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {processEmailJobs} from '../src/email-api.mjs';
import {readFile} from 'node:fs/promises';

const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_fake',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',
 RESEND_API_KEY:'re_test_fake',RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.from('webhook-test-secret').toString('base64'),
 TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:'acceptance@example.invalid',TRANSACTIONAL_EMAIL_FROM:'CP Value Mart <orders@notify.cpvaluemart.com>',TRANSACTIONAL_EMAIL_REPLY_TO:'orders@notify.cpvaluemart.com'};
async function mocked(handler,fn){const original=globalThis.fetch;globalThis.fetch=handler;try{await fn();}finally{globalThis.fetch=original;}}

test('email worker sends only an allowlisted test recipient with a stable idempotency key',async()=>{
 const job={id:'11111111-1111-4111-8111-111111111111',order_id:'22222222-2222-4222-8222-222222222222',kind:'order_confirmation',
  recipient:'acceptance@example.invalid',payload:{orderNumber:'CVM-1004',total:1340,currency:'sgd'},is_test:true,idempotency_key:'order_confirmation/stripe/evt_test',attempt_count:1};
 let sent,finished;
 await mocked(async(url,options)=>{
  if(String(url).includes('reconcile_email_confirmations'))return Response.json(0);
  if(String(url).includes('claim_email_jobs'))return Response.json([job]);
  if(String(url)==='https://api.resend.com/emails'){sent={headers:options.headers,body:JSON.parse(options.body)};return Response.json({id:'email_test_1'});}
  if(String(url).includes('finish_email_attempt')){finished=JSON.parse(options.body);return Response.json(true);}
  throw Error('Unexpected request '+url);
 },async()=>assert.deepEqual(await processEmailJobs(env),{processed:1,configured:true}));
 assert.equal(sent.headers['Idempotency-Key'],job.idempotency_key);assert.deepEqual(sent.body.to,[job.recipient]);
 assert.equal(sent.body.subject,'CP Value Mart · Order confirmed · CVM-1004');assert.match(sent.body.html,/S\$13\.40/);assert.equal(finished.p_success,true);assert.equal(finished.p_provider_id,'email_test_1');
});

test('email worker fails closed before Resend when the test recipient is not allowlisted',async()=>{
 const job={id:'11111111-1111-4111-8111-111111111111',kind:'shipment',recipient:'other@example.invalid',payload:{orderNumber:'CVM-1004',tracking:'TEST'},
  is_test:true,idempotency_key:'shipment/order/version',attempt_count:1};let finished;
 await mocked(async(url,options)=>{
  if(String(url).includes('reconcile_email_confirmations'))return Response.json(0);
  if(String(url).includes('claim_email_jobs'))return Response.json([job]);
  if(String(url).includes('finish_email_attempt')){finished=JSON.parse(options.body);return Response.json(true);}
  throw Error('Unexpected network request '+url);
 },async()=>await processEmailJobs(env));
 assert.equal(finished.p_success,false);assert.equal(finished.p_retryable,false);assert.equal(finished.p_error,'RECIPIENT_NOT_ALLOWED');
});

test('shipment and delivery emails use customer-facing subjects and retain an accurate payment notice',async()=>{
 const job={id:'11111111-1111-4111-8111-111111111112',kind:'delivery',recipient:'acceptance@example.invalid',
  payload:{orderNumber:'CVM-1004'},is_test:true,idempotency_key:'delivery/order/version',attempt_count:1};
 const sent=[];
 const shipment={...job,kind:'shipment',id:'11111111-1111-4111-8111-111111111113',idempotency_key:'shipment/order/version',payload:{...job.payload,tracking:'TRACK-1'}};
 await mocked(async(url,options)=>{
  if(String(url).includes('reconcile_email_confirmations'))return Response.json(0);
  if(String(url).includes('claim_email_jobs'))return Response.json([shipment,job]);
  if(String(url)==='https://api.resend.com/emails'){sent.push(JSON.parse(options.body));return Response.json({id:'email_notice_'+sent.length});}
  if(String(url).includes('finish_email_attempt'))return Response.json(true);
  throw Error('Unexpected request '+url);
 },async()=>assert.deepEqual(await processEmailJobs(env),{processed:2,configured:true}));
 for(const message of sent){
  assert.deepEqual(message.to,['acceptance@example.invalid']);
  assert.match(message.text,/No funds were transferred/);
  assert.doesNotMatch(message.subject+message.text+message.html,/\b(test|sandbox|demo)\b/i);
 }
 assert.equal(sent[0].subject,'CP Value Mart · Order shipped · CVM-1004');
 assert.match(sent[0].text,/Tracking number: TRACK-1/);
 assert.equal(sent[1].subject,'CP Value Mart · Order delivered · CVM-1004');
 assert.match(sent[1].text,/marked as delivered/);
});

test('outbox reconciliation failure does not stop existing due email jobs',async()=>{
 let claimed=false;const originalError=console.error;console.error=()=>{};
 try{
  await mocked(async(url)=>{
   if(String(url).includes('reconcile_email_confirmations'))return Response.json({message:'Unavailable'},{status:503});
   if(String(url).includes('claim_email_jobs')){claimed=true;return Response.json([]);}
   throw Error('Unexpected request '+url);
  },async()=>assert.deepEqual(await processEmailJobs(env),{processed:0,configured:true}));
 }finally{console.error=originalError;}
 assert.equal(claimed,true);
});

test('cancellation and sandbox refund templates stay labelled and allowlisted',async()=>{
 const jobs=['cancellation','test_refund'].map((kind,index)=>({id:`11111111-1111-4111-8111-11111111111${index}`,kind,
  recipient:'acceptance@example.invalid',payload:{orderNumber:'CVM-1004',total:1340},is_test:true,
  idempotency_key:`${kind}/acceptance`,attempt_count:1}));
 const sent=[];
 await mocked(async(url,options)=>{
  if(String(url).includes('reconcile_email_confirmations'))return Response.json(0);
  if(String(url).includes('claim_email_jobs'))return Response.json(jobs);
  if(String(url)==='https://api.resend.com/emails'){
   sent.push(JSON.parse(options.body));return Response.json({id:`email_test_${sent.length}`});
  }
  if(String(url).includes('finish_email_attempt'))return Response.json(true);
  throw Error('Unexpected request '+url);
 },async()=>assert.deepEqual(await processEmailJobs(env),{processed:2,configured:true}));
 assert.equal(sent.length,2);
 for(const message of sent){assert.deepEqual(message.to,['acceptance@example.invalid']);assert.match(message.subject,/^CP Value Mart · /);assert.match(message.text,/No funds were transferred/);assert.doesNotMatch(message.subject+message.text+message.html,/\b(test|sandbox|demo)\b/i);}
 assert.match(sent[0].subject,/cancelled/);assert.match(sent[1].subject,/Refund recorded/);
});

async function signedWebhook(event,id='msg_test_1'){
 const raw=JSON.stringify(event),timestamp=String(Math.floor(Date.now()/1000));
 const key=await crypto.subtle.importKey('raw',Buffer.from('webhook-test-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(id+'.'+timestamp+'.'+raw))).toString('base64');
 return new Request('https://cpvaluemart.com/api/resend/webhook',{method:'POST',headers:{'content-type':'application/json','svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+signature},body:raw});
}
test('Resend webhook verifies the raw Svix signature and records only delivery metadata',async()=>{
 let applied;const event={type:'email.bounced',data:{email_id:'email_test_1',to:['private@example.invalid']}};
 await mocked(async(url,options)=>{if(String(url).includes('apply_email_delivery_event')){applied=JSON.parse(options.body);return Response.json({duplicate:false,matched:true});}throw Error('Unexpected request');},async()=>{
  const response=await worker.fetch(await signedWebhook(event),env);assert.equal(response.status,200);
  const bad=await signedWebhook(event,'msg_test_2');bad.headers.set('svix-signature','v1,'+Buffer.alloc(32).toString('base64'));
  assert.equal((await worker.fetch(bad,env)).status,400);
 });
 assert.deepEqual(applied,{p_event:'msg_test_1',p_message:'email_test_1',p_type:'email.bounced'});assert.equal(JSON.stringify(applied).includes('private@'),false);
});

test('Phase 6 migration persists jobs, retries, suppressions and duplicate event guards',async()=>{
 const sql=await readFile(new URL('../supabase/migrations/20261119140000_phase6_transactional_email.sql',import.meta.url),'utf8');
 assert.match(sql,/create table public\.email_jobs/);assert.match(sql,/unique \(idempotency_key\)|idempotency_key text not null unique/);
 assert.match(sql,/attempt_count<4/);assert.match(sql,/email\.complained/);assert.match(sql,/event_id text primary key/);
 assert.match(sql,/WORKER_LEASE_EXPIRED/);assert.match(sql,/mapped='delivered' and job\.status='sent'/);
 assert.match(sql,/perform public\.enqueue_order_email\(o\.id,'order_confirmation'/);
 assert.match(sql,/previous='Processing' and p_status='Shipped'/);
 assert.match(sql,/revoke all on public\.email_jobs/);
});

test('Cloudflare config schedules finite retry processing and declares only secret names',async()=>{
 const config=await readFile(new URL('../cloudflare.config.ts',import.meta.url),'utf8');
 assert.match(config,/triggers: isPreview \? \[\] : \[triggers\.scheduled\(\{ schedule: '\* \* \* \* \*' \}\)\]/);
 for(const name of ['RESEND_API_KEY','RESEND_WEBHOOK_SECRET','TRANSACTIONAL_EMAIL_TEST_RECIPIENTS'])assert.match(config,new RegExp(name+': bindings\\.secret\\(\\)'));
 assert.doesNotMatch(config,/re_[A-Za-z0-9]{10}/);
});

test('live notifications send to the order recipient without rehearsal copy',async()=>{
 const job={id:'11111111-1111-4111-8111-111111111115',kind:'order_confirmation',recipient:'live-buyer@example.invalid',
  payload:{orderNumber:'CVM-2000',total:1500},is_test:false,idempotency_key:'order/live',attempt_count:1};
 let sent;
 await mocked(async(url,options)=>{
  if(String(url).includes('reconcile_email_confirmations'))return Response.json(0);
  if(String(url).includes('claim_email_jobs'))return Response.json([job]);
  if(String(url)==='https://api.resend.com/emails'){sent=JSON.parse(options.body);return Response.json({id:'receipt_live'});}
  if(String(url).includes('finish_email_attempt'))return Response.json(true);
  throw Error('Unexpected request');
 },async()=>assert.deepEqual(await processEmailJobs({...env,TRANSACTIONAL_EMAIL_TEST_RECIPIENTS:''}),{processed:1,configured:true}));
 assert.deepEqual(sent.to,['live-buyer@example.invalid']);
 assert.match(sent.text,/Order confirmed/);
 assert.doesNotMatch(sent.text+sent.html,/simulated|test order|No funds/i);
});
