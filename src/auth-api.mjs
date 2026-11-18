import { ApiError } from './catalog-api.mjs';
const COOKIE='__Host-cvm-session';
const ORIGINS=new Set(['https://cpvaluemart.com','https://www.cpvaluemart.com']);
const encoder=new TextEncoder();
export const authRoute=path=>path.startsWith('/api/auth/')||path==='/api/profile'||path==='/api/addresses'||path.startsWith('/api/addresses/')||path==='/api/admin'||path.startsWith('/api/admin/');
const bad=(message='Check the form and try again.')=>{throw new ApiError(400,'INVALID_INPUT',message);};
export async function hash(value) {return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function cipherKey(env) {return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode('cvm-auth-at-rest-v1:'+env.SUPABASE_SECRET_KEY)),'AES-GCM',false,['encrypt','decrypt']);}
export async function encrypt(value,env) {
 const iv=crypto.getRandomValues(new Uint8Array(12));const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipherKey(env),encoder.encode(value)));
 return btoa(String.fromCharCode(...iv,...data));
}
export async function decrypt(value,env) {
 const bytes=Uint8Array.from(atob(value),x=>x.charCodeAt(0));
 return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},await cipherKey(env),bytes.slice(12)));
}
export function sessionCookie(value,maxAge=0) {return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
function cookieHashRequest(request) {
 const values=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
 if(values.length!==1)return null;const value=values[0].slice(COOKIE.length+1);
 return /^[a-f0-9]{64}$/.test(value)?value:null;
}
async function upstream(env,path,{method='GET',body,token,service=false,allowFailure=false,prefer='return=representation'}={}) {
 if(env.SUPABASE_URL!=='https://tfrfkvkjmaqnpxdhxumr.supabase.co'||!env.SUPABASE_PUBLISHABLE_KEY||!env.SUPABASE_SECRET_KEY)
  throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');
 let response;
 try { response=await fetch(env.SUPABASE_URL+path,{method,redirect:'manual',signal:AbortSignal.timeout(10000),headers:{apikey:service?env.SUPABASE_SECRET_KEY:env.SUPABASE_PUBLISHABLE_KEY,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json',Prefer:prefer},...(body===undefined?{}:{body:JSON.stringify(body)})}); }
 catch {throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');}
 let data=null;
 if(response.status!==204) {try {data=await response.json();} catch {if(response.ok)throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');}}
 if(!response.ok&&!allowFailure)throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');
 return {ok:response.ok,status:response.status,data};
}
const db=(env,path,options={})=>upstream(env,'/rest/v1/'+path,{...options,service:true});
async function bodyJSON(request) {
 if(!(request.headers.get('Content-Type')??'').startsWith('application/json'))bad();
 const reader=request.body?.getReader();if(!reader)bad();let length=0,chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192){await reader.cancel();throw new ApiError(413,'REQUEST_TOO_LARGE','Form is too large.');}chunks.push(value);}
 const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try {const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||Array.isArray(value)||typeof value!=='object')bad();return value;}catch{bad();}
}
function field(data,key,min,max) {const value=data[key];if(typeof value!=='string'||value.length<min||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))bad();return value;}
function email(data) {const value=field(data,'email',3,254).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))bad('Enter a valid email address.');return value;}
function password(data){return field(data,'password',12,128);}
async function limit(request,env,scope,identity='') {
 const key=await hash(env.SUPABASE_SECRET_KEY+'|'+scope+'|'+(request.headers.get('CF-Connecting-IP')??'unknown')+'|'+identity);
 const r=await db(env,'rpc/consume_auth_limit',{method:'POST',body:{p_key:key,p_limit:scope==='login'?20:5,p_seconds:900}});
 if(r.data!==true)throw new ApiError(429,'TOO_MANY_ATTEMPTS','Too many attempts. Please try again in 15 minutes.');
}
async function identity(request,env,{required=true,allowRecovery=false}={}) {
 const raw=cookieHashRequest(request);const sessionHash=raw?await hash(raw):null;
 const r=sessionHash?await db(env,'rpc/resolve_web_session',{method:'POST',body:{p_hash:sessionHash}}):{data:null};
 if(!r.data?.account){if(required)throw new ApiError(401,'SIGN_IN_REQUIRED','Please sign in again.');return null;}
 if(r.data.recoveryOnly&&!allowRecovery)throw new ApiError(403,'PASSWORD_RESET_REQUIRED','Finish resetting your password first.');
 return {...r.data,sessionHash};
}
function publicIdentity(value){return value?{account:value.account,isAdmin:value.isAdmin,recoveryOnly:value.recoveryOnly,expiresAt:value.expiresAt}:{account:null,isAdmin:false,recoveryOnly:false};}
async function establish(env,data,recoveryOnly) {
 if(!data?.access_token)throw new ApiError(401,'INVALID_LINK','This link is invalid or has expired. Request a new email.');
 const verified=await upstream(env,'/auth/v1/user',{token:data.access_token,allowFailure:true});
 if(!verified.ok||!verified.data?.email_confirmed_at)throw new ApiError(403,'EMAIL_NOT_VERIFIED','Verify your email before signing in.');
 let claims;try{claims=JSON.parse(atob(data.access_token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));}catch{throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');}
 if(claims.sub!==verified.data.id||!claims.session_id||!Number.isFinite(claims.exp))throw new ApiError(503,'AUTH_UNAVAILABLE','Account service is temporarily unavailable.');
 const name=String(verified.data.user_metadata?.display_name??'').slice(0,80).trim();
 await db(env,'buyer_profiles?on_conflict=user_id',{method:'POST',prefer:'resolution=ignore-duplicates,return=representation',body:{user_id:verified.data.id,display_name:name}});
 const maxAge=Math.min(3600,Math.floor(claims.exp-Date.now()/1000));if(maxAge<=0)throw new ApiError(401,'SESSION_EXPIRED','Please sign in again.');
 const raw=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
 await db(env,'server_sessions',{method:'POST',body:{session_hash:await hash(raw),user_id:verified.data.id,auth_session_id:claims.session_id,
  access_token_encrypted:await encrypt(data.access_token,env),recovery_only:recoveryOnly,expires_at:new Date(Date.now()+maxAge*1000).toISOString()}});
 return sessionCookie(raw,maxAge);
}
export async function handleAuth(request,env) {
 const path=new URL(request.url).pathname;
 const read=request.method==='GET';
 if(!read&&request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(!read){const origin=request.headers.get('Origin');if(!ORIGINS.has(origin)||origin!==new URL(request.url).origin)throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');}
 if(new URL(request.url).search)bad();
 const result=(data,cookie,status=200)=>({data,headers:cookie?{'Set-Cookie':cookie}:{},status});
 if(path==='/api/auth/session'&&read){const who=await identity(request,env,{required:false,allowRecovery:true});return result(publicIdentity(who),who?undefined:sessionCookie(''));}
 if(path==='/api/auth/logout'&&!read){const raw=cookieHashRequest(request);if(raw){const sessionHash=await hash(raw);const rows=await db(env,'server_sessions?'+new URLSearchParams({select:'access_token_encrypted',session_hash:'eq.'+sessionHash}));await db(env,'server_sessions?'+new URLSearchParams({session_hash:'eq.'+sessionHash}),{method:'DELETE'});
  if(rows.data?.[0])try{await upstream(env,'/auth/v1/logout?scope=local',{method:'POST',token:await decrypt(rows.data[0].access_token_encrypted,env),allowFailure:true});}catch{/* Local session already revoked. No credential details are logged. */}}
  return result({ok:true},sessionCookie(''));}
 if(['/api/auth/signup','/api/auth/login','/api/auth/recover','/api/auth/resend'].includes(path)&&!read){
  const data=await bodyJSON(request),address=email(data);await limit(request,env,path.endsWith('/login')?'login':'email',address);
  if(path.endsWith('/login')){const pass=field(data,'password',1,128);const r=await upstream(env,'/auth/v1/token?grant_type=password',{method:'POST',body:{email:address,password:pass},allowFailure:true});if(!r.ok)throw new ApiError(r.status===429?429:401,'SIGN_IN_FAILED','Email or password is incorrect, or the email is not verified.');return result({ok:true},await establish(env,r.data,false));}
  if(path.endsWith('/signup')){const pass=password(data);const name=field(data,'name',1,80).trim();const r=await upstream(env,'/auth/v1/signup?redirect_to='+encodeURIComponent('https://cpvaluemart.com/auth/confirm'),{method:'POST',body:{email:address,password:pass,data:{display_name:name}},allowFailure:true});if(!r.ok)throw new ApiError(r.status===429?429:400,'SIGNUP_FAILED','Unable to register. Check your details or request another verification email.');}
  else {const reset=path.endsWith('/recover');const r=await upstream(env,reset?'/auth/v1/recover?redirect_to='+encodeURIComponent('https://cpvaluemart.com/auth/reset'):'/auth/v1/resend',{method:'POST',body:reset?{email:address}:{email:address,type:'signup'},allowFailure:true});if(!r.ok&&r.status!==400)throw new ApiError(r.status===429?429:503,'EMAIL_UNAVAILABLE','Unable to send email now. Try again later.');}
  return result({ok:true,message:'If this address is eligible, an email will arrive shortly. Check your inbox and spam folder.'},undefined,202);
 }
 if(path==='/api/auth/verify'&&!read){const data=await bodyJSON(request);const tokenHash=field(data,'token_hash',32,512);if(!/^[A-Za-z0-9_-]+$/.test(tokenHash)||!['email','recovery'].includes(data.type))bad();await limit(request,env,'verify');
  const r=await upstream(env,'/auth/v1/verify',{method:'POST',body:{token_hash:tokenHash,type:data.type},allowFailure:true});if(!r.ok)throw new ApiError(400,'INVALID_LINK','This link is invalid or has expired. Request a new email.');
  if(data.type==='email'){
   const user=await upstream(env,'/auth/v1/user',{token:r.data.access_token,allowFailure:true});
   if(!user.ok||!user.data?.email_confirmed_at)throw new ApiError(400,'INVALID_LINK','This link is invalid or has expired. Request a new email.');
   try{await upstream(env,'/auth/v1/logout?scope=local',{method:'POST',token:r.data.access_token,allowFailure:true});}catch{}
   return result({ok:true,recoveryOnly:false,requiresLogin:true,message:'Email verified. Sign in with your password.'});
  }
  return result({ok:true,recoveryOnly:true},await establish(env,r.data,true));
 }
 const who=await identity(request,env,{allowRecovery:path==='/api/auth/password'});
 if(path==='/api/auth/password'&&!read){const data=await bodyJSON(request);const pass=password(data);await limit(request,env,'password',who.account.id);
  const row=await db(env,'server_sessions?'+new URLSearchParams({select:'access_token_encrypted',session_hash:'eq.'+who.sessionHash}));if(!row.data?.[0])throw new ApiError(401,'SIGN_IN_REQUIRED','Please sign in again.');
  const token=await decrypt(row.data[0].access_token_encrypted,env);const changed=await upstream(env,'/auth/v1/user',{method:'PUT',token,body:{password:pass},allowFailure:true});if(!changed.ok)throw new ApiError(400,'PASSWORD_UPDATE_FAILED','Password could not be changed. Use a new password or request another reset link.');
  await db(env,'server_sessions?'+new URLSearchParams({user_id:'eq.'+who.account.id}),{method:'DELETE'});try{await upstream(env,'/auth/v1/logout?scope=global',{method:'POST',token,allowFailure:true});}catch{}
  return result({ok:true,message:'Password updated. Sign in with your new password.'},sessionCookie(''));
 }
 if(path==='/api/admin'||path.startsWith('/api/admin/')){if(!who.isAdmin)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');if(path==='/api/admin/access'&&read)return result(publicIdentity(who));throw new ApiError(404,'NOT_FOUND','API endpoint not found.');}
 if(path==='/api/profile') {if(read){const r=await db(env,'buyer_profiles?'+new URLSearchParams({select:'display_name,version',user_id:'eq.'+who.account.id}));return result({profile:r.data[0]??{display_name:'',version:0},account:who.account});}
  const data=await bodyJSON(request);if('user_id'in data)bad();const name=field(data,'name',1,80).trim();if(!name)bad();const rows=await db(env,'buyer_profiles?'+new URLSearchParams({user_id:'eq.'+who.account.id}),{method:'PATCH',body:{display_name:name}});if(!rows.data.length)await db(env,'buyer_profiles',{method:'POST',body:{user_id:who.account.id,display_name:name}});return result({ok:true});}
 if(/^\/api\/addresses\/[a-f0-9-]{36}$/.test(path)&&!read){const data=await bodyJSON(request);if(data.action!=='delete')bad();const id=path.split('/').at(-1);const r=await db(env,'buyer_addresses?'+new URLSearchParams({id:'eq.'+id,user_id:'eq.'+who.account.id}),{method:'DELETE'});if(!r.data.length)throw new ApiError(404,'NOT_FOUND','Address not found.');return result({ok:true});}
 if(path==='/api/addresses'){if(read){const r=await db(env,'buyer_addresses?'+new URLSearchParams({select:'id,full_name,address_line,postal_code,country_code,version',user_id:'eq.'+who.account.id,order:'created_at.asc'}));return result({addresses:r.data});}
  const data=await bodyJSON(request);if('user_id'in data||'country_code'in data)bad();const full_name=field(data,'name',1,80).trim(),address_line=field(data,'address',1,200).trim(),postal_code=field(data,'postal',6,6);if(!/^[0-9]{6}$/.test(postal_code))bad('Enter a six-digit Singapore postal code.');
  const r=await db(env,'buyer_addresses',{method:'POST',body:{user_id:who.account.id,full_name,address_line,postal_code,country_code:'SG'}});return result({address:r.data[0]},undefined,201);}
 throw new ApiError(404,'NOT_FOUND','API endpoint not found.');
}
