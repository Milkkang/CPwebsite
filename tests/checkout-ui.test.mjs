import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {state} from '../dist/store.js';
import {card,cart,checkout,confirmation,detail} from '../dist/shop.js';

test('guests cannot add products to a browser basket',()=>{
 const product=state.products.find(row=>row.status==='Published'&&row.variants[0].stock>=row.variants[0].min);
 state.account=null;
 const cardHtml=card(product,{quickAdd:true});
 const detailHtml=detail(product,new URLSearchParams());
 assert.doesNotMatch(cardHtml,/data-quick-add/);
 assert.match(cardHtml,/Sign in to add/);
 assert.doesNotMatch(detailHtml,/id="add-to-cart"/);
 assert.match(detailHtml,/Sign in to add to basket/);
 assert.match(cart(),/Sign in to your account/);
});

test('member shopping startup discards legacy guest cart instead of merging it',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 const sync=source.match(/async function syncShopping\(\) \{[\s\S]*?\n\}/)?.[0]??'';
 assert.match(sync,/state\.cart=\{\};state\.saved=\[\];state\.recentlyViewed=\[\];\n  save\(\);/);
 assert.doesNotMatch(sync,/action:'merge'/);
 assert.match(source,/throw Error\('Sign in to add products to your basket\.'\)/);
 assert.match(source,/let shoppingOwner,shoppingLoading=false/);
 assert.match(source,/privateBuyerRoutes=new Set\(\['\/cart'/);
 assert.match(source,/\^\\\/product\\\//);
});

test('guests are sent to sign in instead of saving items locally',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 const handler=source.match(/else if\('save' in data\) \{[\s\S]*?\n  \}/)?.[0]??'';
 assert.match(handler,/return navigate\('\/account',\{next:location\.hash\.slice\(1\)\|\|'\/saved'\}\)/);
 assert.doesNotMatch(handler,/state\.saved\s*=/);
});

test('checkout uses only a saved address and labels Stripe sandbox clearly',()=>{
 const product=state.products.find(row=>row.status==='Published'&&row.variants[0].stock>=row.variants[0].min);
 state.account={id:'test',email:'buyer@example.invalid',name:'Buyer'};
 state.cart={[product.id]:product.variants[0].min};
 const html=checkout([{id:'88888888-8888-4888-8888-888888888888',full_name:'Buyer',address_line:'Saved address',postal_code:'000001',is_default:true}]);
 assert.match(html,/Stripe sandbox only/);assert.match(html,/Stripe test checkout/);assert.match(html,/name="addressId"/);
 assert.doesNotMatch(html,/name="address"/);assert.doesNotMatch(html,/card number/i);
});

test('Stripe return displays the matched order details link only after confirmation',()=>{
 const pending=confirmation({status:'checking',orderNumber:'CVM-1051'});
 assert.match(pending,/Checking test payment/);
 assert.doesNotMatch(pending,/View order details|payment confirmed/i);
 const paid=confirmation({status:'paid',orderNumber:'CVM-1051'});
 assert.match(paid,/Test payment confirmed/);
 assert.match(paid,/>CVM-1051</);
 assert.match(paid,/href="#\/orders\?id=CVM-1051">View order details</);
});

async function openCheckoutReturn(t,hash,fetchHandler){
 t.mock.timers.enable({apis:['setTimeout']});
 const app={innerHTML:'',querySelector:()=>null},documentEvents=new Map(),windowEvents=new Map();
 const location=new URL('https://cpvaluemart.com/'+hash);
 const globals={location,history:{replaceState(_state,_title,hash){location.hash=hash;}},
  document:{getElementById:()=>app,addEventListener:(event,fn)=>documentEvents.set(event,fn),body:{classList:{toggle(){}}}},
  window:{addEventListener:(event,fn)=>windowEvents.set(event,fn),scrollTo(){}},
  FormData:class extends URLSearchParams {constructor(form){super(form.values);}},BroadcastChannel:undefined};
 for(const [key,value] of Object.entries(globals)){
  const previous=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>previous?Object.defineProperty(globalThis,key,previous):delete globalThis[key]);
 }
 const paths=[];
 const account={id:'buyer',email:'buyer@example.invalid',name:'Buyer'};
 t.mock.method(globalThis,'fetch',async(path,options)=>{
  paths.push([path,options.method]);
  const response=fetchHandler?.(path,options);
  if(response)return response;
  switch(path){
   case '/api/auth/session': return Response.json({account});
   case '/api/orders': return Response.json({orders:[{id:'older',number:'CVM-1050',createdAt:'2026-11-20T12:00:00Z',paymentStatus:'paid',items:[]}]});
   case '/api/shopping': return Response.json({cart:[],saved:[],recent:[]});
   case '/api/traffic': return Response.json({ok:true});
   case '/api/addresses': return Response.json({addresses:[]});
   default: throw Error('Unexpected request '+path);
  }
 });
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const {auth}=await import('../dist/auth.js');
 Object.assign(auth,{account:null,isAdmin:false,recoveryOnly:false,loading:true,error:''});
 await import('../dist/app.js?'+encodeURIComponent(t.name));
 await settle();
 return {app,paths,location,settle,documentEvents,windowEvents};
}

test('Stripe return waits for this session even when the basket is empty and an older order is paid',async t=>{
 const query='session_id=cs_test_current',statusPath='/api/checkout/status?'+query;
 let paymentStatus='pending';
 const {app,paths,location,settle,windowEvents}=await openCheckoutReturn(t,'#/confirmation?'+query,path=>{
  if(path===statusPath)return Response.json({orderNumber:'CVM-1051',paymentStatus});
  if(path==='/api/orders?id=CVM-1051')return Response.json({orders:[{id:'current',number:'CVM-1051',
   createdAt:'2026-11-20T12:00:00Z',paymentStatus:'paid',fulfilmentStatus:'Processing',total:1340,items:[]}]});
 });
 assert.match(app.innerHTML,/Checking test payment/);
 assert.match(app.innerHTML,/>CVM-1051</);
 assert.doesNotMatch(app.innerHTML,/CVM-1050|View order details/);
 paymentStatus='paid';
 t.mock.timers.tick(1000);
 await settle();
 assert.match(app.innerHTML,/Test payment confirmed/);
 const details=app.innerHTML.match(/href="(#\/orders\?id=CVM-1051)">View order details</)?.[1];
 assert.ok(details);
 assert.deepEqual(paths.filter(([path])=>path.startsWith('/api/checkout')),Array(2).fill([statusPath,'GET']));
 location.hash=details;
 windowEvents.get('hashchange')();
 await settle();
 assert.match(app.innerHTML,/<h2>CVM-1051<\/h2>/);
 assert.doesNotMatch(app.innerHTML,/CVM-1050|Order not found/);
});

test('Stripe return can retry a request failure or a timed out check for the same session',async t=>{
 const query='session_id=cs_test_retry',statusPath='/api/checkout/status?'+query;
 let scenario='unavailable';
 const {app,paths,location,settle,documentEvents}=await openCheckoutReturn(t,'#/confirmation?'+query,(path,options)=>{
  if(path!==statusPath)return;
  if(scenario==='unavailable')return Response.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503});
  if(scenario==='hanging')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  return Response.json({orderNumber:'CVM-1052',paymentStatus:'expired'});
 });
 const retry=()=>documentEvents.get('click')({target:{closest:()=>({dataset:{retryCheckoutStatus:''}})}});
 assert.match(app.innerHTML,/Payment status temporarily unavailable/);
 assert.match(app.innerHTML,/data-retry-checkout-status/);
 assert.match(app.innerHTML,/href="#\/orders">View Purchase History/);
 scenario='hanging';
 await retry();
 assert.match(app.innerHTML,/Checking test payment/);
 t.mock.timers.tick(16000);
 await settle();
 assert.match(app.innerHTML,/Still waiting for payment confirmation/);
 assert.match(app.innerHTML,/data-retry-checkout-status/);
 scenario='expired';
 await retry();
 await settle();
 assert.match(app.innerHTML,/Test checkout expired/);
 assert.match(app.innerHTML,/>CVM-1052</);
 assert.match(app.innerHTML,/href="#\/checkout">Return to checkout/);
 assert.match(app.innerHTML,/href="#\/shop">Continue shopping/);
 assert.equal(location.hash,'#/confirmation?'+query);
 assert.deepEqual(paths.filter(([path])=>path.startsWith('/api/checkout')),Array(3).fill([statusPath,'GET']));
});

test('a buyer who signs in again reopens the same Stripe checkout return',async t=>{
 const query='session_id=cs_test_relogin',statusPath='/api/checkout/status?'+query;
 let signedIn=false;
 const {app,paths,location,settle,documentEvents,windowEvents}=await openCheckoutReturn(t,'#/confirmation?'+query,path=>{
  if(path==='/api/auth/session'&&!signedIn)return Response.json({account:null});
  if(path==='/api/auth/login'){signedIn=true;return Response.json({ok:true});}
  if(path===statusPath)return Response.json({orderNumber:'CVM-1053',paymentStatus:'paid'});
 });
 const next=app.innerHTML.match(/id="auth-login" data-next="([^"]+)"/)?.[1];
 assert.equal(next,'/confirmation?'+query);
 assert.equal(paths.some(([path])=>path===statusPath),false);
 const button={disabled:false};
 await documentEvents.get('submit')({preventDefault(){},submitter:button,target:{id:'auth-login',querySelector:()=>null,
  dataset:{next},values:{email:'buyer@example.invalid',password:'fixture-password'}}});
 assert.equal(location.hash,'#/confirmation?'+query);
 windowEvents.get('hashchange')();
 await settle();
 assert.match(app.innerHTML,/Test payment confirmed/);
 assert.match(app.innerHTML,/>CVM-1053</);
 assert.deepEqual(paths.filter(([path])=>path.startsWith('/api/checkout')),[[statusPath,'GET']]);
});

test('admin order loading includes email audit status and a controlled resend action',async()=>{
 const [app,admin]=await Promise.all([readFile(new URL('../dist/app.js',import.meta.url),'utf8'),readFile(new URL('../dist/admin.js',import.meta.url),'utf8')]);
 assert.match(app,/authRequest\('\/api\/admin\/email-jobs'\)/);assert.match(app,/action:'resend',jobId:data\.resendEmail/);
 assert.match(admin,/Transactional email/);assert.match(admin,/\['failed','bounced'\]\.includes\(job\.status\)/);
 assert.doesNotMatch(admin,/complained'\]\.includes/);
});
