import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyticsData} from '../dist/analytics.js';

test('partially refunded merchandise orders contribute only retained cash to sales',()=>{
 const day='2026-11-20';
 const sale={date:day,status:'Delivered',paymentStatus:'paid',livePayment:true,totals:{total:4500},refundedCents:1800};
 const result=analyticsData({from:day,to:day},'1d',[sale]);
 assert.equal(result.totals.sales,2700);
 assert.equal(result.totals.orders,1);
});
import {state,syncAutoReceipts} from '../dist/store.js';
import worker from '../src/worker.mjs';
test('test orders never become real revenue or invented visitor traffic',()=>{
 const result=analyticsData({from:'2026-11-20',to:'2026-11-20'},'1d',[{date:'2026-11-20',status:'Processing',paymentStatus:'paid',totals:{total:5000}}]);
 assert.equal(result.totals.sales,0);assert.equal(result.totals.visitors,0);assert.equal(result.totals.cartVisitors,0);
});
test('browser timers cannot mark server orders delivered',()=>{
 const previous=state.orders;
 try{state.orders=[{backendId:'server-order',status:'Shipped',shippedAt:1}];syncAutoReceipts(Date.now());assert.equal(state.orders[0].status,'Shipped');}finally{state.orders=previous;}
});
test('admin bulk import accepts a bounded batch and rejects unprivileged or oversized input',async()=>{
 const env={SUPABASE_URL:'https://tfrfkvkjmaqnpxdhxumr.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fake',SUPABASE_SECRET_KEY:'sb_secret_fake'};
 const account={id:'11111111-1111-4111-8111-111111111111',email:'qa@example.invalid'};
 let isAdmin=true,writes=0;
 const previous=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('resolve_web_session'))return Response.json({account,isAdmin});
  assert.match(String(url),/admin_import_products$/);writes++;
  const body=JSON.parse(options.body);assert.equal(body.p_actor,account.id);return Response.json(body.p_rows.length);
 };
 const send=data=>worker.fetch(new Request('https://cpvaluemart.com/api/admin/import',{method:'POST',headers:{Origin:'https://cpvaluemart.com',Cookie:'__Host-cvm-session='+'a'.repeat(64),'Content-Type':'application/json'},body:JSON.stringify(data)}),env);
 try{
  const rows=Array.from({length:100},(_,i)=>({sku:'QA-'+i,version:1,stock:5,fields:{name:'Synthetic fixture '+i,price_cents:250}}));
  assert.equal((await send({rows})).status,200);assert.equal(writes,1);
  isAdmin=false;assert.equal((await send({rows})).status,403);assert.equal(writes,1);
  isAdmin=true;assert.equal((await send({rows:[...rows,{sku:'BAD',stock:-1,version:1,fields:{}}]})).status,400);assert.equal(writes,1);
  assert.equal((await send({rows,note:'x'.repeat(2*1024*1024)})).status,413);assert.equal(writes,1);
 }finally{globalThis.fetch=previous;}
});
