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
