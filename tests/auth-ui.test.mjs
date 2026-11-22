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
 const {auth,profilePanel,adminGate}=await import('../dist/auth.js');
 const {shopFrame}=await import('../dist/shop.js');
 const previous={...auth};
 try{
  Object.assign(auth,{account:{name:'QA Admin'},isAdmin:true});
  const html=shopFrame(profilePanel(),'',{showAdminLink:false});
  assert.match(html,/id="auth-profile"/);
  assert.doesNotMatch(html,/href="#\/admin(?:[/?"])/);
  assert.match(shopFrame(''),/href="#\/admin"/);
  assert.match(adminGate(),/href="#\/account\?next=\/admin"/);
 }finally{Object.assign(auth,previous);}
});
