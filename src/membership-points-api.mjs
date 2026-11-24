import { ApiError } from './catalog-api.mjs';
import { bodyJSON, db, identity, isAllowedOrigin } from './auth-api.mjs';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const email=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requestedPoints(value=0){
 if(!Number.isInteger(value)||value<0||value>2147483647||(value>0&&value<100))
  throw new ApiError(400,'POINTS_MINIMUM','Enter a whole number. Points redemption starts at 100 points.');
 return value;
}

export async function readBuyerPoints(env,accountId){
 return (await db(env,'rpc/read_member_points',{method:'POST',body:{p_user:accountId}})).data;
}

export async function adminMemberPoints(request,env,enabled){
 if(!['GET','POST'].includes(request.method))throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(request.method==='POST'&&!isAllowedOrigin(request))
  throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
 const who=await identity(request,env);
 if(who.isAdmin!==true)throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
 if(!enabled)throw new ApiError(409,'POINTS_UNAVAILABLE','Points management is available when formal membership checkout is active.');
 const read=request.method==='GET';
 let path,input;
 if(read){
  const matches=new URL(request.url).searchParams.getAll('email');
  const value=matches[0]?.trim();
  if(matches.length!==1||!email.test(value)||value.length>254)
   throw new ApiError(400,'INVALID_INPUT','Enter the customer’s account email.');
  path='read_admin_member_points';
  input={p_email:value};
 }else{
  const data=await bodyJSON(request);
  const reason=typeof data.reason==='string'?data.reason.trim():'';
  if(typeof data.accountId!=='string'||!uuid.test(data.accountId)||
     typeof data.requestId!=='string'||!uuid.test(data.requestId)||
     !Number.isInteger(data.points)||!data.points||Math.abs(data.points)>1000000||
     !reason||reason.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason))
   throw new ApiError(400,'INVALID_INPUT','Enter a signed whole number of points and a reason.');
  path='adjust_member_points';
  input={p_user:data.accountId,p_points:data.points,p_reason:reason,p_request:data.requestId};
 }
 const {ok,data}=await db(env,'rpc/'+path,{method:'POST',body:{p_actor:who.account.id,...input},allowFailure:true});
 if(!ok){
  if(data?.code==='42501')throw new ApiError(403,'ADMIN_REQUIRED','Administrator access is required.');
  if(data?.message==='POINTS_LIMIT')throw new ApiError(409,'POINTS_LIMIT','The member has fewer available points than this adjustment.');
  if(data?.message==='POINTS_REQUEST_CHANGED')throw new ApiError(409,'POINTS_REQUEST_CHANGED','This adjustment request already has a different result.');
  if(data?.message==='POINTS_ADJUSTMENT_INVALID')throw new ApiError(409,'POINTS_UNAVAILABLE','This account cannot receive points adjustments.');
  throw new ApiError(503,'POINTS_UNAVAILABLE','Points are temporarily unavailable.');
 }
 if(read&&!data)throw new ApiError(404,'MEMBER_NOT_FOUND','No account matches this email.');
 return {status:200,data:read?data:{accountId:input.p_user,points:data}};
}
