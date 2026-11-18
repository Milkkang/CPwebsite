// The public storefront reads the same published rows as the Worker API.
export function listingFromApi(row,{admin=false}={}) {
  if (!row || typeof row.sku !== 'string' || !Number.isSafeInteger(row.price_cents))
    throw new Error('Catalog data is invalid.');
  const available = Number.isSafeInteger(row.available_quantity) ? row.available_quantity : 0;
  return {
    id: row.sku, sku: row.sku, name: row.name, brand: row.brand,
    category: row.category_id, description: row.description ?? '',
    keywords: row.keywords ?? '', status: row.status, featured: row.featured,
    image: row.image_url, original: row.original_image_url, r2: row.r2_image_url,
    version: row.version, reserved:row.reserved_quantity??0,
    variants: [{sku: row.sku, name: row.variant_name || row.name,
      price: row.price_cents, stock: admin?row.stock:available, min: row.min_quantity,
      image: row.image_url}]
  };
}

export async function catalogRequest(path) {
  const response = await fetch(path, {credentials:'same-origin', cache:'no-store'});
  if (!response.ok) throw new Error('The catalog is temporarily unavailable. Please retry.');
  return response.json();
}

export function catalogQuery(params, category='') {
  const query = new URLSearchParams();
  for (const key of ['q','brand','sort','size','page']) {
    const value=params.get(key);
    if (value) query.set(key,value);
  }
  if (category) query.set('category',category);
  return '/api/products?'+query;
}

export function isNewProductView(product,current,previous) {
  return Boolean(product&&current&&current!==previous);
}
