import { ApiError, catalogRoute, readCatalog } from './catalog-api.mjs';

function json(body, status, requestId, extra = {}) {
  return new Response(JSON.stringify({ ...body, requestId }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId, ...extra }
  });
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== '/api' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const requestId = crypto.randomUUID();
    const start = performance.now();
    let response;
    const route = catalogRoute(pathname);
    try {
      if (pathname === '/api/health') {
        response = ['GET', 'HEAD'].includes(request.method)
          ? json({ ok: true, service: 'cpvaluemart-api', phase: 2 }, 200, requestId)
          : json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405, requestId, { Allow: 'GET, HEAD' });
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
  }
};
