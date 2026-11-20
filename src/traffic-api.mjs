import {ApiError} from './catalog-api.mjs';
import {bodyJSON,db,hash,isAllowedOrigin} from './auth-api.mjs';

export async function recordTraffic(request,env){
 if(request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED','Method not allowed.');
 if(!isAllowedOrigin(request))throw new ApiError(403,'INVALID_ORIGIN','Reload this page before trying again.');
 if(new URL(request.url).search)throw new ApiError(400,'INVALID_INPUT','Invalid traffic request.');
 const data=await bodyJSON(request,256);
 if(Object.keys(data).length!==1||!['visit','cart'].includes(data.event))throw new ApiError(400,'INVALID_INPUT','Invalid traffic event.');
 const key=await hash(env.SUPABASE_SECRET_KEY+'|traffic|'+(request.headers.get('CF-Connecting-IP')??'unknown'));
 const limited=await db(env,'rpc/consume_auth_limit',{method:'POST',body:{p_key:key,p_limit:600,p_seconds:3600}});
 if(limited.data!==true)throw new ApiError(429,'TOO_MANY_EVENTS','Traffic limit reached.');
 await db(env,'rpc/record_site_traffic',{method:'POST',body:{p_event:data.event}});
 return {data:{recorded:true},status:202};
}
