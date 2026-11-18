export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = message => { throw new ApiError(400, 'INVALID_QUERY', message); };
export function catalogParameters(params) {
  const allowed = new Set(['q','category','brand','sort','size','page']);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) fail('Unknown or repeated query parameter.');
  }
  const text = (key, max) => {
    const value = (params.get(key) ?? '').trim();
    if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('Invalid ' + key + '.');
    return value;
  };
  const sizeText = params.get('size') ?? '30';
  if (!['30','50','100'].includes(sizeText)) fail('Products per page must be 30, 50 or 100.');
  const pageText = params.get('page') ?? '1';
  if (!/^[1-9][0-9]{0,6}$/.test(pageText) || Number(pageText) > 1000000) fail('Invalid page.');
  const sort = params.get('sort') ?? 'featured';
  if (!['featured','price-up','price-down','name'].includes(sort)) fail('Invalid sort.');
  return { p_query: text('q',120), p_category: text('category',80), p_brand: text('brand',120),
    p_sort: sort, p_size: Number(sizeText), p_page: Number(pageText) };
}

async function database(env, path, options = {}) {
  // The read API intentionally uses anon/RLS privileges, never a service secret.
  if (!env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_URL !== 'https://tfrfkvkjmaqnpxdhxumr.supabase.co')
    throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'Catalog is temporarily unavailable.');
  try {
    const response = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw Error('Database request failed');
    return await response.json();
  } catch {
    throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'Catalog is temporarily unavailable.');
  }
}
export function catalogRoute(pathname) {
  if (pathname === '/api/products') return 'products';
  if (/^\/api\/products\/[^/]+$/.test(pathname)) return 'product-detail';
  if (pathname === '/api/categories') return 'categories';
  if (pathname === '/api/config') return 'public-config';
  return null;
}
export async function readCatalog(request, env, route) {
  const url = new URL(request.url);
  if (!['GET','HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (route === 'products') return database(env,'rpc/read_catalog', {
    method: 'POST', body: JSON.stringify(catalogParameters(url.searchParams))
  });
  if (url.search) fail('This endpoint does not accept query parameters.');
  if (route === 'product-detail') {
    let sku;
    try { sku = decodeURIComponent(url.pathname.split('/').at(-1)); } catch { fail('Invalid SKU.'); }
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(sku)) fail('Invalid SKU.');
    const rows = await database(env,'products?' + new URLSearchParams({ select:'id,sku,name,variant_name,brand,category_id,description,keywords,status,featured,image_url,original_image_url,r2_image_url,price_cents,currency,stock,available_quantity,min_quantity,version',sku:'eq.'+sku,status:'eq.Published',limit:'1' }));
    if (!rows.length) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    return { product: rows[0] };
  }
  if (route === 'categories') return { categories: await database(env,'categories?select=id,name,icon,color,sort_order,version&order=sort_order.asc,id.asc&published=eq.true') };
  const [homepage, delivery] = await Promise.all([
    database(env,'homepage_config?select=content,version&id=eq.home&published=eq.true'),
    database(env,'delivery_rules?select=id,country_code,shipping_cents,free_threshold_cents,version&active=eq.true&order=id.asc')
  ]);
  return { homepage: homepage[0]?.content ?? null, homepageVersion: homepage[0]?.version ?? null, delivery, currency:'SGD' };
}
