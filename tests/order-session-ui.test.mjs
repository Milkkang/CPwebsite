import assert from 'node:assert/strict';
import {test} from 'node:test';

const previewKey='cvm-preview-13m-20261118-v1';
const adminOrderId='77777777-7777-4777-8777-777777777777';
const buyerOrderId='88888888-8888-4888-8888-888888888888';
const day='2026-11-22T01:00:00Z';
const buyer={id:'buyer',name:'Synthetic Buyer',email:'buyer@example.invalid'};
const admin={id:'administrator',name:'Synthetic Admin',email:'admin@example.invalid'};
const replacement={id:'replacement',name:'New Buyer',email:'new-buyer@example.invalid'};
const legacyOrder={id:'CVM-LEGACY',items:[],email:'legacy@example.invalid',name:'Legacy Recipient',address:'Legacy Delivery Address'};
const legacy={products:[],cart:{},saved:[],recentlyViewed:[],settings:{shipping:320,support:'public@example.invalid'},coupons:[],searches:{soap:{count:2,misses:0}},coupon:'FIXTURE',orders:[legacyOrder],account:{email:legacyOrder.email},nextOrder:2048};

function memoryStorage() {
 const values=new Map();
 return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),values:()=>[...values.values()]};
}
function deferred() {
 let resolve;
 const pending=new Promise(complete=>{resolve=complete;});
 return {pending,resolve};
}
function until(condition) {
 return new Promise((resolve,reject)=>{
  const check=(attempt=0)=>{
   if(condition())resolve();
   else if(attempt===100)reject(new Error('The expected page did not render.'));
   else setImmediate(()=>check(attempt+1));
  };
  check();
 });
}
function order(number,owner) {
 const id=number==='CVM-2077'?adminOrderId:number==='CVM-1321'?buyerOrderId:'row-'+number;
 return {id,number,createdAt:day,version:0,name:owner.name,email:owner.email,
  address:{name:'Synthetic Recipient',line:'Delivery '+number,postal:'000001'},fulfilmentStatus:'Shipped',tracking:'Tracking '+number,
  items:[{sku:'fixture-sku',name:'Item '+number,option:'Single',price:800,qty:1}],subtotal:800,shipping:100,discount:0,total:900,paymentStatus:'paid'};
}
function startBrowser() {
 const elements=new Map();
 globalThis.location=new URL('https://shop.example.invalid/#/orders');
 globalThis.history={state:null,replaceState(_state,_title,url){location=new URL(url,location);}};
 globalThis.localStorage=memoryStorage();
 globalThis.sessionStorage=memoryStorage();
 globalThis.FormData=class extends URLSearchParams {constructor(form){super(form.values);}};
 globalThis.window=Object.assign(new EventTarget(),{scrollTo(){}});
 globalThis.document=Object.assign(new EventTarget(),{visibilityState:'visible',body:{classList:{toggle(){}}},
  getElementById(id) {
   if(!elements.has(id))elements.set(id,{innerHTML:'',open:false,querySelector(){return null;},close(){this.open=false;}});
   return elements.get(id);
  }});
 const authChannel=new EventTarget();
 globalThis.BroadcastChannel=class {
  addEventListener(...args){authChannel.addEventListener(...args);}
  postMessage(){}
 };
 let session={account:buyer,isAdmin:false,recoveryOnly:false};
 const orders=new Map([[buyer.id,[order('CVM-BUYER',buyer)]],[admin.id,[order('CVM-1321',admin)]],[replacement.id,[order('CVM-NEW-BUYER',replacement)]]]);
 let adminOrders=[order('CVM-2077',buyer)];
 const handlers=new Map(),orderRequests=[];
 globalThis.fetch=async (path,options)=>{
  if(path==='/api/orders'||path==='/api/admin/orders'||path==='/api/admin/email-jobs')orderRequests.push({path,cache:options?.cache});
  if(handlers.has(path))return handlers.get(path)(options,session);
  if(path.startsWith('/api/orders?id=')){
   const id=new URL(path,location).searchParams.get('id');
   return Response.json({orders:(orders.get(session.account?.id)??[]).filter(row=>[row.id,row.number].includes(id))});
  }
  switch(path) {
   case '/api/auth/session':return Response.json(session);
   case '/api/auth/logout':session={account:null,isAdmin:false,recoveryOnly:false};return Response.json({ok:true});
   case '/api/addresses':return Response.json({addresses:[]});
   case '/api/orders':return Response.json({orders:orders.get(session.account?.id)??[]});
   case '/api/admin/access':return Response.json(session);
   case '/api/admin/products':return Response.json({products:[]});
   case '/api/admin/config':return Response.json({coupons:[]});
   case '/api/admin/orders':return Response.json({orders:adminOrders});
   case '/api/admin/email-jobs':return Response.json({jobs:[]});
   case '/api/admin/search':return Response.json({searches:[]});
   case '/api/admin/categories':return Response.json({categories:[{id:'others',name:'Others',color:'sage'}]});
   case '/api/admin/traffic':return Response.json({traffic:{}});
   case '/api/shopping':return Response.json({cart:[],saved:[],recent:[]});
   case '/api/traffic':return Response.json({accepted:true});
   default:throw Error('Unexpected request: '+path);
  }
 };
 return {
  get html(){return elements.get('app')?.innerHTML??'';},
  get toast(){return elements.get('toast')?.textContent??'';},
  handlers,orders,orderRequests,
  setSession(account,isAdmin=false){session={account,isAdmin,recoveryOnly:false};},
  tabChanged(){authChannel.dispatchEvent(new Event('message'));},
  route(hash){location.hash=hash;window.dispatchEvent(new Event('hashchange'));},
  click(dataset){
   const event=new Event('click');
   Object.defineProperty(event,'target',{value:{closest:()=>({dataset})}});
   document.dispatchEvent(event);
  },
  submit(id,path,values){
   const event=new Event('submit',{cancelable:true});
   Object.defineProperty(event,'target',{value:{id,dataset:{path},values}});
   document.dispatchEvent(event);
  },
  visible(){document.dispatchEvent(new Event('visibilitychange'));},
  stored(raw){localStorage.setItem(previewKey,raw);window.dispatchEvent(Object.assign(new Event('storage'),{key:previewKey,newValue:raw}));}
 };
}

test('order screens use the current authorized browser session',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const browser=startBrowser();
 await t.test('upgrading clears legacy order details and keeps public preferences',async()=>{
  localStorage.setItem(previewKey,JSON.stringify(legacy));
  localStorage.setItem('cvm-preview-2026-v2',JSON.stringify({orders:[legacyOrder]}));
  localStorage.setItem('unrelated-preference','compact');
  await import('../dist/app.js');
  await until(()=>browser.html.includes('CVM-BUYER'));
  assert.doesNotMatch(browser.html,/CVM-LEGACY|Legacy Recipient/);
  const stored=localStorage.getItem(previewKey);
  assert.doesNotMatch(stored,/CVM-|legacy@example\.invalid|Legacy Delivery Address/);
  const preferences=JSON.parse(stored);
  assert.equal(preferences.settings.shipping,320);
  assert.equal(preferences.coupon,'FIXTURE');
  assert.deepEqual(preferences.searches,{soap:{count:2,misses:0}});
  assert.equal(localStorage.getItem('cvm-preview-2026-v2'),null);
  assert.equal(localStorage.getItem('unrelated-preference'),'compact');
 });
 await t.test('an administrator’s purchase history and fulfilment records load independently',async()=>{
  const memberResponse=deferred();
  browser.handlers.set('/api/orders',()=>memberResponse.pending);
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders/CVM-2077');
  await until(()=>browser.html.includes('Delivery CVM-2077'));
  assert.match(browser.html,/Synthetic Buyer|buyer@example\.invalid/);
  memberResponse.resolve(Response.json({orders:browser.orders.get(admin.id)}));
  await new Promise(setImmediate);
  assert.match(browser.html,/Delivery CVM-2077/);
  assert.doesNotMatch(browser.html,/CVM-1321/);
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-1321'));
  assert.doesNotMatch(browser.html,/CVM-2077|CVM-BUYER/);
  assert.doesNotMatch([...localStorage.values(),...sessionStorage.values()].join('\n'),/CVM-|example\.invalid.*Delivery|Synthetic Buyer|Tracking CVM/);
  assert.ok(browser.orderRequests.some(request=>request.path==='/api/orders'));
  assert.ok(browser.orderRequests.some(request=>request.path==='/api/admin/orders'));
  assert.ok(browser.orderRequests.every(request=>request.cache==='no-store'));
  browser.handlers.delete('/api/orders');
 });
 await t.test('a tab session change clears details before checking the new identity',async()=>{
  browser.route('#/orders?id=CVM-1321');
  await until(()=>browser.html.includes('Tracking CVM-1321'));
  assert.equal(location.hash,'#/orders?id='+buyerOrderId);
  const sessionResponse=deferred();
  browser.handlers.set('/api/auth/session',()=>sessionResponse.pending);
  browser.setSession(buyer);
  browser.tabChanged();
  assert.doesNotMatch(browser.html,/CVM-1321|admin@example\.invalid/);
  sessionResponse.resolve(Response.json({account:buyer,isAdmin:false,recoveryOnly:false}));
  await until(()=>browser.html.includes('CVM-BUYER'));
  assert.equal(location.hash,'#/orders');
  assert.doesNotMatch(browser.html,/CVM-1321|CVM-2077/);
  browser.handlers.delete('/api/auth/session');
 });
 await t.test('a legacy storage write cannot replace any current order state',()=>{
  const oldBuyerOrder={...legacyOrder,email:buyer.email};
  browser.stored(JSON.stringify({...legacy,orders:[oldBuyerOrder],adminOrders:[oldBuyerOrder],coupon:'SECOND'}));
  assert.match(browser.html,/CVM-BUYER/);
  assert.doesNotMatch(browser.html,/CVM-LEGACY|Legacy Recipient/);
  const stored=localStorage.getItem(previewKey);
  assert.doesNotMatch(stored,/CVM-|Legacy Recipient|Delivery Address/);
  assert.equal(JSON.parse(stored).coupon,'SECOND');
 });
 await t.test('logout and login as the same buyer ignore an earlier order response',async()=>{
  const oldResponse=deferred();
  let started=false;
  browser.handlers.set('/api/orders',()=>{started=true;return oldResponse.pending;});
  browser.visible();
  await until(()=>started);
  browser.route('#/account');
  assert.match(browser.html,/data-sign-out/);
  browser.click({signOut:''});
  await until(()=>browser.html.includes('Sign in to your account'));
  assert.doesNotMatch(browser.html,/CVM-BUYER|Tracking CVM/);
  browser.handlers.delete('/api/orders');
  browser.orders.set(buyer.id,[order('CVM-SAME-BUYER-NEW-SESSION',buyer)]);
  browser.setSession(buyer);
  browser.tabChanged();
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-SAME-BUYER-NEW-SESSION'));
  oldResponse.resolve(Response.json({orders:[order('CVM-STALE-BUYER',buyer)]}));
  await new Promise(setImmediate);
  assert.match(browser.html,/CVM-SAME-BUYER-NEW-SESSION/);
  assert.doesNotMatch(browser.html,/CVM-STALE-BUYER/);
 });
 await t.test('a denied admin action clears delivery details and preserves buyer access',async()=>{
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders/CVM-2077');
  await until(()=>browser.html.includes('Delivery CVM-2077'));
  assert.match(browser.html,/buyer@example\.invalid/);
  browser.setSession(admin,false);
  browser.handlers.set('/api/admin/access',()=>Response.json({error:{code:'ADMIN_REQUIRED',message:'Administrator access is required.'}},{status:403}));
  browser.click({orderAction:'refund',orderId:'CVM-2077'});
  await until(()=>browser.html.includes('does not have administrator access'));
  assert.doesNotMatch(browser.html,/CVM-2077|Synthetic Buyer|buyer@example\.invalid/);
  assert.equal(location.hash,'#/admin/orders');
  browser.handlers.delete('/api/admin/access');
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-1321'));
  assert.doesNotMatch(browser.html,/CVM-2077/);
 });
 await t.test('opening a cached admin order waits for fresh authorization',async()=>{
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders');
  await until(()=>browser.html.includes('CVM-2077'));
  browser.route('#/admin/products');
  const access=deferred();
  browser.handlers.set('/api/admin/access',()=>access.pending);
  browser.setSession(admin,false);
  browser.route('#/admin/orders/CVM-2077');
  assert.doesNotMatch(browser.html,/Delivery CVM-2077|buyer@example\.invalid/);
  access.resolve(Response.json({error:{code:'ADMIN_REQUIRED',message:'Administrator access is required.'}},{status:403}));
  await until(()=>browser.html.includes('does not have administrator access'));
  assert.equal(location.hash,'#/admin/orders');
  browser.handlers.delete('/api/admin/access');
 });
 await t.test('a visible admin order clears without a navigation when access is revoked',async()=>{
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders/CVM-2077');
  await until(()=>browser.html.includes('Delivery CVM-2077'));
  browser.setSession(admin,false);
  browser.handlers.set('/api/admin/access',()=>Response.json({error:{code:'ADMIN_REQUIRED',message:'Administrator access is required.'}},{status:403}));
  t.mock.timers.tick(30_000);
  await until(()=>browser.html.includes('does not have administrator access'));
  assert.doesNotMatch(browser.html,/CVM-2077|buyer@example\.invalid/);
  browser.handlers.delete('/api/admin/access');
 });
 await t.test('a delayed receipt response cannot update the replacement buyer’s page',async()=>{
  const receipt=deferred();
  browser.handlers.set('/api/orders/receipt',()=>receipt.pending);
  browser.route('#/orders?view=receive');
  assert.match(browser.html,/data-receive-order="CVM-1321"/);
  browser.click({receiveOrder:'CVM-1321'});
  browser.setSession(replacement);
  browser.tabChanged();
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-NEW-BUYER'));
  receipt.resolve(Response.json({ok:true}));
  await new Promise(setImmediate);
  assert.equal(location.hash,'#/orders');
  assert.doesNotMatch(browser.toast,/Receipt confirmed/);
  assert.match(browser.html,/CVM-NEW-BUYER/);
  assert.doesNotMatch(browser.html,/CVM-1321/);
  browser.handlers.delete('/api/orders/receipt');
 });
 await t.test('a delayed admin list cannot overwrite orders verified for a new admin session',async()=>{
  const oldResponse=deferred();
  let started=false;
  browser.handlers.set('/api/admin/orders',()=>{started=true;return oldResponse.pending;});
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders');
  await until(()=>started);
  browser.handlers.delete('/api/admin/orders');
  browser.tabChanged();
  await until(()=>browser.html.includes('CVM-2077'));
  oldResponse.resolve(Response.json({orders:[order('CVM-STALE-ADMIN',buyer)]}));
  await new Promise(setImmediate);
  assert.match(browser.html,/CVM-2077/);
  assert.doesNotMatch(browser.html,/CVM-STALE-ADMIN/);
 });
 await t.test('a delayed authorization failure cannot sign out the current buyer',async()=>{
  const oldResponse=deferred();
  let started=false;
  browser.handlers.set('/api/orders',()=>{started=true;return oldResponse.pending;});
  browser.visible();
  await until(()=>started);
  browser.handlers.delete('/api/orders');
  browser.setSession(replacement);
  browser.tabChanged();
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-NEW-BUYER'));
  oldResponse.resolve(Response.json({error:{code:'SIGN_IN_REQUIRED',message:'Sign in again.'}},{status:401}));
  await new Promise(setImmediate);
  assert.match(browser.html,/CVM-NEW-BUYER/);
  assert.doesNotMatch(browser.toast,/Sign in again/);
  assert.doesNotMatch([...localStorage.values(),...sessionStorage.values()].join('\n'),/CVM-|(?:buyer|new-buyer|admin)@example\.invalid|Synthetic Buyer|Legacy Recipient/);
 });
 await t.test('administrator order searches stay in memory and detail links use opaque IDs',async()=>{
  browser.setSession(admin,true);
  browser.tabChanged();
  browser.route('#/admin/orders?q=buyer%40example.invalid');
  await until(()=>browser.html.includes('CVM-2077'));
  assert.equal(location.hash,'#/admin/orders');
  assert.match(browser.html,/name="q" value="buyer@example\.invalid"/);
  assert.doesNotMatch(browser.html,/href="[^"]*(?:CVM-2077|buyer%40example\.invalid)/);
  assert.ok(browser.html.includes('href="#/admin/orders/'+adminOrderId));
  browser.submit('admin-filter','/admin/orders',{q:'Synthetic Buyer'});
  await until(()=>browser.html.includes('value="Synthetic Buyer"'));
  assert.equal(location.hash,'#/admin/orders');
  browser.route('#/admin/orders/CVM-2077?origin=orders');
  await until(()=>browser.html.includes('Delivery CVM-2077'));
  assert.equal(location.hash,'#/admin/orders/'+adminOrderId+'?origin=orders');
  assert.match(browser.html,/href="#\/admin\/orders">← Orders/);
  browser.setSession(replacement);
  browser.tabChanged();
  browser.route('#/orders');
  await until(()=>browser.html.includes('CVM-NEW-BUYER'));
 });
 await t.test('checkout return ignores an earlier session’s late payment result',async()=>{
  const path='/api/checkout/status?session_id=cs_test_privacyFixture';
  const oldResponse=deferred();
  let oldSignal;
  browser.handlers.set(path,(options,session)=>{
   if(session.account.id===replacement.id){oldSignal=options.signal;return oldResponse.pending;}
   return Response.json({error:{code:'CHECKOUT_NOT_FOUND',message:'Test checkout unavailable.'}},{status:404});
  });
  browser.route('#/confirmation?session_id=cs_test_privacyFixture');
  await until(()=>oldSignal);
  assert.match(browser.html,/Checking test payment/);
  browser.setSession(buyer);
  browser.tabChanged();
  await until(()=>browser.html.includes('Test checkout unavailable'));
  assert.equal(oldSignal.aborted,true);
  assert.equal(location.hash,'#/confirmation?session_id=cs_test_privacyFixture');
  oldResponse.resolve(Response.json({orderNumber:'CVM-31415',paymentStatus:'paid'}));
  await new Promise(setImmediate);
  assert.match(browser.html,/Test checkout unavailable/);
  assert.doesNotMatch(browser.html,/CVM-31415/);
  assert.doesNotMatch([...localStorage.values(),...sessionStorage.values()].join('\n'),/CVM-31415|cs_test_privacyFixture/);
 });
});
