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
