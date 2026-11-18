import { escape as e } from './store.js';
export const auth={account:null,isAdmin:false,recoveryOnly:false,loading:true,error:''};
let callback=null;
const initial=new URL(location.href);
if(['/auth/confirm','/auth/reset'].includes(initial.pathname)) {
 const type=initial.pathname==='/auth/reset'?'recovery':'email';
 const token_hash=initial.searchParams.get('token_hash');
 if(initial.searchParams.get('type')===type&&/^[A-Za-z0-9_-]{32,512}$/.test(token_hash??''))callback={type,token_hash};
 history.replaceState(null,'','/#/account?mode='+ (callback?'verify':'invalid'));
}
let expiryTimer, refreshRun=0;
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('cvm-auth'):null;
export let onAuthChange=()=>{};
export function setAuthListener(fn){onAuthChange=fn;channel?.addEventListener('message',()=>refreshSession());}
export async function authRequest(path,data) {
 const r=await fetch(path,{method:data===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:data===undefined?{}:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});
 let body;try{body=await r.json();}catch{throw Error('Account service is unavailable. Please try again.');}
 if(!r.ok){if(r.status===401){Object.assign(auth,{account:null,isAdmin:false,recoveryOnly:false});onAuthChange();}const error=Error(body.error?.message??'Request failed. Please try again.');error.code=body.error?.code;throw error;}
 return body;
}
export async function refreshSession() {
 const run=++refreshRun;clearTimeout(expiryTimer);
 try{const data=await authRequest('/api/auth/session');if(run!==refreshRun)return auth;Object.assign(auth,data,{loading:false,error:''});if(data.expiresAt)expiryTimer=setTimeout(refreshSession,Math.max(1000,new Date(data.expiresAt).getTime()-Date.now()+500));}
 catch{if(run!==refreshRun)return auth;Object.assign(auth,{account:null,isAdmin:false,recoveryOnly:false,loading:false,error:'Unable to check your session. Try again.'});}
 onAuthChange();return auth;
}
export async function signOut(){await authRequest('/api/auth/logout',{});Object.assign(auth,{account:null,isAdmin:false,recoveryOnly:false});channel?.postMessage('changed');onAuthChange();}
const input=(label,name,type='text',extra='')=>'<label>'+label+'<input name="'+name+'" type="'+type+'" '+extra+' required></label>';
const pass=(autocomplete='current-password')=>input('Password','password','password','autocomplete="'+autocomplete+'" '+(autocomplete==='new-password'?'minlength="12" ':'')+'maxlength="128"');
export function authForms(params) {
 const mode=params.get('mode')??'login';
 const status='<p data-auth-status role="status" class="notice" hidden></p>';
 if(auth.loading)return '<section class="panel narrow"><h1>My account</h1><p role="status">Checking your session…</p></section>';
 if(auth.error)return '<section class="panel narrow"><h1>My account</h1><p role="alert">'+e(auth.error)+'</p><button class="btn primary" data-auth-retry>Try again</button></section>';
 if(mode==='invalid')return '<section class="panel narrow"><h1>Email link unavailable</h1><p>This link is invalid or incomplete. Request a new verification or password reset email.</p><a class="btn outline" href="#/account?mode=recover">Reset password</a> <a class="text-link" href="#/account?mode=resend">Resend verification</a></section>';
 if(callback)return '<section class="panel narrow"><h1>'+(callback.type==='recovery'?'Reset your password':'Verify your email')+'</h1><p>Continue to confirm this email link.</p><form id="auth-verify" class="form-stack"><button class="btn primary">'+(callback.type==='recovery'?'Continue password reset':'Verify my email')+'</button>'+status+'</form></section>';
 if(auth.recoveryOnly)return '<section class="panel narrow"><h1>Choose a new password</h1><p>Account: '+e(auth.account?.email)+'</p><form id="auth-password" class="form-stack">'+pass('new-password')+input('Confirm password','confirmPassword','password','autocomplete="new-password" minlength="12" maxlength="128"')+'<p>Use 12–128 characters.</p><button class="btn primary">Save new password</button>'+status+'</form></section>';
 if(auth.account&&!['recover','resend'].includes(mode))return null;
 const email=input('Email address','email','email','autocomplete="email" maxlength="254"');
 if(mode==='register')return '<section class="panel narrow"><h1>Create your account</h1><form id="auth-signup" class="form-stack">'+input('Name','name','text','autocomplete="name" maxlength="80"')+email+pass('new-password')+'<p>Use 12–128 characters. Verify your email before signing in.</p><button class="btn primary">Create account</button>'+status+'</form><p>Already registered? <a href="#/account">Sign in</a></p></section>';
 if(mode==='recover'||mode==='resend')return '<section class="panel narrow"><h1>'+(mode==='recover'?'Reset your password':'Resend verification email')+'</h1><form id="auth-'+mode+'" class="form-stack">'+email+'<button class="btn primary">Send email</button>'+status+'</form><p><a href="#/account">Back to sign in</a></p></section>';
 return '<section class="panel narrow"><h1>Sign in to your account</h1><form id="auth-login" data-next="'+e(params.get('next')??'')+'" class="form-stack">'+email+pass()+'<button class="btn primary">Sign in</button>'+status+'</form><p><a href="#/account?mode=register">Create an account</a> · <a href="#/account?mode=recover">Forgot password?</a></p><p><a href="#/account?mode=resend">Resend verification email</a></p></section>';
}
export async function submitAuth(form,fields) {
 const action=form.id.slice(5);
 if(action==='password'&&fields.password!==fields.confirmPassword)throw Error('Passwords do not match.');
 const path=action==='profile'?'/api/profile':action==='address'?'/api/addresses':'/api/auth/'+action;
 let result;
 try{result=await authRequest(path,action==='verify'?callback:fields);}
 catch(error){if(action==='verify'&&error.code==='INVALID_LINK'){callback=null;history.replaceState(null,'','/#/account?mode=invalid');onAuthChange();}throw error;}
 if(action==='verify')callback=null;
 if(['login','verify','password','profile'].includes(action)){channel?.postMessage('changed');await refreshSession();}
 if(action==='address')await loadAddresses();
 return result;
}
export function adminGate() {
 return '<main class="wrap" id="main"><section class="panel narrow"><h1>Administrator access</h1><p>'+(auth.loading?'Checking your session…':auth.account?'This account does not have administrator access.':'Sign in with your verified administrator account.')+'</p><a class="btn primary" href="#/account?next=/admin">Sign in</a></section></main>';
}
export function profilePanel(){return '<section class="panel"><h2>Account details</h2><form id="auth-profile" class="form-stack"><label>Name<input name="name" value="'+e(auth.account?.name)+'" required maxlength="80" autocomplete="name"></label><button class="btn outline">Save name</button><p data-auth-status role="status" class="notice" hidden></p></form>'+(auth.isAdmin?'<a class="btn outline" href="#/admin">Open admin</a>':'')+'</section>';}
export function passwordPanel(){return '<section class="panel"><h2>Change password</h2><p>After saving, sign in again with your new password.</p><form id="auth-password" class="form-stack">'+input('Current password','currentPassword','password','autocomplete="current-password" maxlength="128"')+input('New password','password','password','autocomplete="new-password" minlength="12" maxlength="128"')+input('Confirm new password','confirmPassword','password','autocomplete="new-password" minlength="12" maxlength="128"')+'<button class="btn primary">Save password</button><p data-auth-status role="status" class="notice" hidden></p></form></section>';}
let addresses=null,addressError='',addressOwner='';
export async function loadAddresses(){try{addresses=(await authRequest('/api/addresses')).addresses;addressError='';addressOwner=auth.account?.id;}catch(error){addresses=[];addressError=error.message;}onAuthChange();}
export function addressesPanel(){
 if(addressOwner!==auth.account?.id){addresses=null;addressOwner=auth.account?.id;}
 if(addresses===null){addresses=[];queueMicrotask(loadAddresses);}
 return '<section class="panel"><h2>Delivery addresses</h2><p>Your default address is shown first. Select Set default on another address to change it.</p><div role="status">'+e(addressError)+'</div><div class="account-address-list">'+(addresses.length?addresses.map(a=>'<article class="panel address-card"><div class="address-heading"><h3>'+e(a.full_name)+'</h3>'+(a.is_default?'<strong class="badge status-published">Default</strong>':'<button class="btn outline address-default" data-default-address="'+e(a.id)+'" aria-label="Set address for '+e(a.full_name)+' as default">Set default</button>')+'</div><p>'+e(a.address_line)+'<br>Singapore '+e(a.postal_code)+'</p><button class="btn outline" data-delete-address="'+e(a.id)+'">Remove address</button></article>').join(''):'<p class="subtle">No delivery addresses saved yet.</p>')+'</div><details class="add-address"><summary class="text-link">Add address</summary><form id="auth-address" class="form-stack">'+input('Full name','name','text','maxlength="80" autocomplete="name"')+input('Address and unit','address','text','maxlength="200" autocomplete="street-address"')+input('Singapore postal code','postal','text','pattern="[0-9]{6}" inputmode="numeric" maxlength="6" autocomplete="postal-code"')+'<button class="btn primary">Save address</button><p data-auth-status role="status" class="notice" hidden></p></form></details></section>';
}
