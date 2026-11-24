import {test} from 'node:test';
import assert from 'node:assert/strict';

test('expired verification link is removed and the resend form remains reachable',async()=>{
 globalThis.localStorage={getItem:()=>null,removeItem(){},setItem(){}};
 globalThis.location=new URL('https://cpvaluemart.com/auth/confirm?token_hash='+'a'.repeat(64)+'&type=email');
 globalThis.history={replaceState(_a,_b,url){globalThis.location=new URL(url,'https://cpvaluemart.com');}};
 globalThis.BroadcastChannel=undefined;
 const {auth,authForms,submitAuth}=await import('../dist/auth.js');auth.loading=false;
 assert.equal(globalThis.location.search,'');assert.equal(globalThis.location.href.includes('token_hash'),false);
 assert.ok(authForms(new URLSearchParams('mode=verify')).includes('Verify my email'));
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{code:'INVALID_LINK',message:'This link is invalid or has expired.'}},{status:400});
 try{await assert.rejects(()=>submitAuth({id:'auth-verify'},{}));}finally{globalThis.fetch=original;}
 assert.ok(globalThis.location.hash.includes('mode=invalid'));
 const body=authForms(new URLSearchParams('mode=resend'));
 assert.ok(body.includes('Resend verification email'));assert.equal(body.includes('Verify my email'),false);
});

test('address list labels the default and offers selection only for other addresses',async()=>{
 const {auth,loadAddresses,addressesPanel}=await import('../dist/auth.js');auth.account={id:'fixture-owner'};
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({addresses:[
  {id:'address-a',full_name:'First',address_line:'Test A',postal_code:'000001',is_default:true},
  {id:'address-b',full_name:'Second',address_line:'Test B',postal_code:'000002',is_default:false}
 ]});
 try{await loadAddresses();}finally{globalThis.fetch=original;}
 const html=addressesPanel();assert.equal(html.split('>Default</strong>').length-1,1);
 assert.equal(html.includes('data-default-address="address-a"'),false);assert.ok(html.includes('data-default-address="address-b"'));
 assert.ok(html.includes('>Set default</button>'));assert.equal(html.includes('Press +'),false);
});

test('the account page has no admin shortcut, including for administrator profiles',async()=>{
 const {auth,profilePanel}=await import('../dist/auth.js');
 const {shopFrame}=await import('../dist/shop.js');
 const previous={...auth};
 try{
  Object.assign(auth,{account:{name:'QA Admin'},isAdmin:true});
  const html=shopFrame(profilePanel(),'',{showAdminLink:false});
  assert.match(html,/id="auth-profile"/);
  assert.doesNotMatch(html,/href="#\/admin(?:[/?"])/);
  assert.match(shopFrame(''),/href="#\/admin"/);
 }finally{Object.assign(auth,previous);}
});

test('admin sign-in and recovery render directly and allow a buyer to switch accounts',async()=>{
 const {auth,adminGate,passwordPanel,submitAuth}=await import('../dist/auth.js');
 const {adminPage}=await import('../dist/admin.js');
 const previous={...auth}, original=globalThis.fetch;
 try{
  Object.assign(auth,{account:null,isAdmin:false,recoveryOnly:false,loading:false,error:''});
  const login=adminGate(new URLSearchParams());
  assert.match(login,/id="auth-login"/);
  assert.match(login,/href="#\/admin\?mode=recover"/);
  assert.match(adminGate(new URLSearchParams('mode=recover')),/id="auth-recover"[\s\S]*href="#\/admin"/);
  Object.assign(auth,{account:{id:'buyer'}});
  globalThis.fetch=async()=>Response.json({error:{code:'SIGN_IN_FAILED',message:'Incorrect password'}},{status:401});
  await assert.rejects(submitAuth({id:'auth-login'},{email:'fixture@example.invalid',password:'invalid'}),/Incorrect password/);
  const denied=adminGate(new URLSearchParams());
  assert.match(denied,/does not have administrator access[\s\S]*data-sign-out/);
  assert.doesNotMatch(denied,/id="auth-login"/);
  assert.match(adminPage('settings','',new URLSearchParams(),passwordPanel()),/Change password[\s\S]*name="currentPassword"/);
 }finally{Object.assign(auth,previous);globalThis.fetch=original;}
});

test('admin auth forms retain typed values when the tab regains focus',async t=>{
 const listeners=new Map(), windowListeners=new Map();
 const location=new URL('https://cpvaluemart.com/#/admin');
 const app={
  set innerHTML(html){
   const id=html.match(/<form id="(auth-login|auth-recover)"/)?.[1];
   this.form=id?{id,email:'',password:''}:null;
  },
  querySelector(){return null;}
 };
 const dialog={open:false};
 const document={
  visibilityState:'visible',body:{classList:{toggle(){}}},
  getElementById:id=>id==='app'?app:dialog,
  addEventListener:(event,callback)=>listeners.set(event,callback)
 };
 const window={addEventListener:(event,callback)=>windowListeners.set(event,callback),scrollTo(){}};
 for(const [name,value] of Object.entries({location,document,window})){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  t.after(()=>descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name]);
 }
 t.mock.method(globalThis,'fetch',async path=>{
  assert.equal(path,'/api/auth/session');
  return Response.json({account:null,isAdmin:false,recoveryOnly:false});
 });
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 await import('../dist/app.js');
 await settle();
 assert.equal(app.form.id,'auth-login');
 app.form.email='admin@example.invalid';
 app.form.password='test-only-password';
 listeners.get('visibilitychange')();
 await settle();
 assert.equal(app.form.email,'admin@example.invalid');
 assert.equal(app.form.password,'test-only-password');

 location.hash='#/admin?mode=recover';
 windowListeners.get('hashchange')();
 assert.equal(app.form.id,'auth-recover');
 assert.equal(app.form.password,'');
 app.form.email='recovery@example.invalid';
 listeners.get('visibilitychange')();
 await settle();
 assert.equal(app.form.email,'recovery@example.invalid');
});

test('an ambiguous refund is reconciled by its original opaque request ID after reload',async t=>{
 const listeners=new Map(),storage=new Map();
 const account={id:'fixture-refund-admin',name:'Synthetic Admin'};
 const order={id:'99999999-9999-4999-8999-999999999999',number:'CVM-REFUND-1',version:1,
  createdAt:'2026-11-24T00:00:00Z',email:'synthetic-recipient@example.invalid',name:'Synthetic Buyer',
  address:{name:'Synthetic Buyer',line:'Synthetic Address',postal:'123456'},fulfilmentStatus:'Processing',
  paymentStatus:'paid',items:[],subtotal:1000,shipping:0,discount:0,total:1000};
 const app={innerHTML:'',querySelector(){return null;}};
 const dialog={open:false};
 const document={body:{classList:{toggle(){}}},getElementById:id=>id==='app'?app:id==='refund-restock'?{checked:false}:dialog,
  addEventListener:(name,listener)=>listeners.set(name,listener)};
 const window={addEventListener(){},confirm(){return true;}};
 const sessionStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 for(const [name,value] of Object.entries({location:new URL('https://cpvaluemart.com/#/admin/orders/'+order.number),document,window,sessionStorage,BroadcastChannel:undefined,localStorage:{getItem:()=>null,removeItem(){},setItem(){}}})){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  t.after(()=>descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name]);
 }
 const calls=[];
 const responses={
  '/api/auth/session':{account,isAdmin:true,recoveryOnly:false},'/api/orders':{orders:[]},
  '/api/shopping':{cart:[],saved:[],recent:[]},'/api/admin/products':{products:[]},'/api/admin/config':{coupons:[]},
  '/api/admin/access':{},'/api/admin/email-jobs':{jobs:[]},'/api/admin/search':{searches:[]},'/api/admin/categories':{categories:[]},'/api/admin/traffic':{}};
 t.mock.method(globalThis,'fetch',async(path,options)=>{
  if(path==='/api/admin/orders')return Response.json({orders:[order]});
  if(path==='/api/admin/order-actions'){
   calls.push(JSON.parse(options.body));
   if(calls.length===1){Object.assign(order,{version:2,paymentStatus:'refunded',fulfilmentStatus:'Cancelled',refundedCents:1000});throw Error('Connection lost');}
   return Response.json({refund:{amount:1000}});
  }
  assert.ok(path in responses,path);
  return Response.json(responses[path]);
 });
 const waitFor=async pattern=>{
  for(let i=0;i<30&&!pattern.test(app.innerHTML);i++)await new Promise(resolve=>setImmediate(resolve));
  assert.match(app.innerHTML,pattern);
 };
 const click=orderAction=>listeners.get('click')({target:{closest:()=>({dataset:{orderAction,orderId:order.number}})}});
 await import('../dist/app.js?refund-initial');
 await waitFor(/data-order-action="refund"/);
 await click('refund');
 assert.match(calls[0].requestId,/^[0-9a-f-]{36}$/);
 assert.deepEqual([...storage.values()],[calls[0].requestId]);
 assert.doesNotMatch([...storage.keys()].join(),/fixture-refund-admin|99999999|Synthetic/i);
 app.innerHTML='';
 await import('../dist/app.js?refund-reload');
 await waitFor(/data-order-action="resume_refund"/);
 await click('resume_refund');
 assert.deepEqual(calls[1],{orderId:order.id,action:'resume_refund',requestId:calls[0].requestId});
 assert.equal(storage.size,0);
 assert.doesNotMatch(app.innerHTML,/data-order-action="resume_refund"/);
});
