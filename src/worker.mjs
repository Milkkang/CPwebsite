import { authRoute, handleAuth } from './auth-api.mjs';
import { ApiError, catalogRoute, readCatalog } from './catalog-api.mjs';
import { commerceRoute, handleCommerce } from './commerce-api.mjs';
import { emailRoute, handleEmail, processEmailJobs } from './email-api.mjs';

function json(body, status, requestId, extra = {}) {
  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId, ...extra }
  });
}

export default {
  async fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (['/auth/confirm','/auth/reset'].includes(pathname)) {
      if(request.method!=='GET'&&request.method!=='HEAD') return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
      const asset=await env.ASSETS.fetch(new Request(new URL('/',request.url),request));
      const response=new Response(asset.body,asset);
      response.headers.set('Cache-Control','no-store');
      response.headers.set('Referrer-Policy','no-referrer');
      response.headers.set('X-Content-Type-Options','nosniff');
      response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://pub-aff260a936bf43069b7b2903e0af2f9c.r2.dev data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      return response;
    }
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    const start = performance.now();
    let response;
    const route = emailRoute(pathname) ? 'email-api' : commerceRoute(pathname) ? 'commerce-api' : authRoute(pathname) ? 'account-api' : catalogRoute(pathname);
    try {
      if (pathname === '/api/health') {
        response = ['GET', 'HEAD'].includes(request.method)
          ? json({ ok: true, service: 'cpvaluemart-api', phase: 6 }, 200, requestId)
          : json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405, requestId, { Allow: 'GET, HEAD' });
      } else if (route === 'email-api') {
        const result=await handleEmail(request,env);
        response=json(result.data,result.status,requestId,result.headers);
        if(pathname==='/api/admin/email-jobs'&&request.method==='POST')ctx?.waitUntil?.(processEmailJobs(env));
      } else if (route === 'commerce-api') {
        const result=await handleCommerce(request,env);
        response=json(result.data,result.status,requestId,result.headers);
        if(pathname==='/api/stripe/webhook'&&request.method==='POST')ctx?.waitUntil?.(processEmailJobs(env));
      } else if (route === 'account-api') {
        const result=await handleAuth(request,env);
        response=json(result.data,result.status,requestId,result.headers);
      } else if (route) {
        response = json(await readCatalog(request, env, route), 200, requestId);
      } else {
        response = json({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } }, 404, requestId);
      }
    } catch (error) {
      const known = error instanceof ApiError;
      const status = known ? error.status : 500;
      response = json({ error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Unable to process request.' } }, status, requestId, status === 405 ? { Allow: 'GET, HEAD' } : {});
    }
    // Fixed route labels only: never log URL queries, user paths, headers, body or secrets.
    console.log(JSON.stringify({ requestId, method: request.method, route: pathname === '/api/health' ? 'health' : (route ?? 'unmatched-api'),
      status: response.status, durationMs: Math.round(performance.now() - start) }));
    return request.method === 'HEAD' ? new Response(null, response) : response;
  },
  async scheduled(_controller,env,ctx){ctx.waitUntil(processEmailJobs(env));}
};
