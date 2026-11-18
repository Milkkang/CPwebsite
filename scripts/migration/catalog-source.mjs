import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
// Import exactly the same listing conversion used by the existing storefront.
globalThis.localStorage = { getItem: () => null, removeItem() {}, setItem() {} };
const { state, categories, homepageDefaults } = await import('../../dist/store.js');
export const products = state.products.map((p, sort_order) => {
  const v = p.variants[0];
  if (p.variants.length !== 1 || p.id !== v.sku) throw Error('Expected one listing per SKU');
  return { id: p.id, sku: v.sku, name: p.name, variant_name: v.name, brand: p.brand,
    category_id: p.category, description: p.description, keywords: p.keywords,
    status: p.status, featured: p.featured, image_url: p.image,
    original_image_url: p.original, r2_image_url: p.r2, price_cents: v.price,
    stock: v.stock, min_quantity: v.min, sort_order };
});
export const seed = {
  categories: categories.map(([id, name, icon, color], sort_order) => ({ id, name, icon, color, sort_order })),
  products,
  homepage: homepageDefaults,
  delivery: { id: 'singapore', country_code: 'SG', shipping_cents: state.settings.shipping, free_threshold_cents: state.settings.threshold },
  coupons: state.coupons.map(c => ({ code: c.code, kind: c.type, amount: c.amount, minimum_cents: c.min, active: c.active }))
};
export const sourceHash = createHash('sha256').update(await readFile(new URL('../../dist/catalog.js', import.meta.url))).digest('hex');
export const datasetHash = createHash('sha256').update(JSON.stringify(seed)).digest('hex');
