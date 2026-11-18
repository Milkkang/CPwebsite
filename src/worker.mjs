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
    try {
      if (pathname === '/api/health') {
        response = ['GET', 'HEAD'].includes(request.method)
          ? json({ ok: true, service: 'cpvaluemart-api', phase: 1 }, 200, requestId)
          : json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }, 405, requestId, { Allow: 'GET, HEAD' });
      } else {
        response = json({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } }, 404, requestId);
      }
    } catch {
      response = json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to process request.' } }, 500, requestId);
    }
    // Fixed route labels only: never log URL queries, user paths, headers, body or secrets.
    console.log(JSON.stringify({ requestId, method: request.method, route: pathname === '/api/health' ? 'health' : 'unmatched-api',
      status: response.status, durationMs: Math.round(performance.now() - start) }));
    return request.method === 'HEAD' ? new Response(null, response) : response;
  }
};
