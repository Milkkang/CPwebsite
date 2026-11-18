import { readFile } from 'node:fs/promises';
import { seed } from './catalog-source.mjs';
export function compareExport(data) {
  if (data.format !== 'cpvaluemart-business-export-v1' || !Array.isArray(data.products)) throw Error('Unsupported export');
  const expected = new Map(seed.products.map(p=>[p.sku,p]));
  const seen = new Set(), added=[], changed=[], duplicates=[];
  for(const p of data.products) for(const v of p.variants ?? []) {
    if(seen.has(v.sku)) duplicates.push(v.sku);seen.add(v.sku);
    const original=expected.get(v.sku);
    if(!original) {added.push(v.sku);continue;}
    const values={ name:p.name,variant_name:v.name,brand:p.brand,category_id:p.category,keywords:p.keywords,
      status:p.status,featured:p.featured,description:p.description,image_url:p.image,original_image_url:p.original,r2_image_url:p.r2,
      price_cents:v.price,stock:v.stock,min_quantity:v.min };
    const fields=Object.keys(values).filter(k=>JSON.stringify(values[k])!==JSON.stringify(original[k]));
    if(fields.length) changed.push({sku:v.sku,fields});
  }
  return { added,missing:[...expected.keys()].filter(sku=>!seen.has(sku)),changed,duplicates,
    shippingChanged:data.settings?.shipping!==seed.delivery.shipping_cents,
    thresholdChanged:data.settings?.threshold!==seed.delivery.free_threshold_cents,
    homepageChanged:JSON.stringify({...seed.homepage,...data.settings?.homepage})!==JSON.stringify(seed.homepage),
    couponsChanged:JSON.stringify(data.coupons)!==JSON.stringify(seed.coupons.map(c=>({code:c.code,type:c.kind,amount:c.amount,min:c.minimum_cents,active:c.active}))),
    action:'Review only. No database changes are made.' };
}
if(process.argv[1]?.endsWith('compare.mjs')) {
  if(!process.argv[2]) throw Error('Usage: node scripts/migration/compare.mjs <business-export.json>');
  console.log(JSON.stringify(compareExport(JSON.parse(await readFile(process.argv[2],'utf8'))),null,2));
}
