import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../scripts/migration/catalog-source.mjs';
import { compareExport } from '../scripts/migration/compare.mjs';
import { readFile } from 'node:fs/promises';

test('all 678 repository listings retain unique SKUs, exact cents, images and initial stock', async()=>{
  const report=JSON.parse(await readFile('data/phase-2-import-report.json','utf8'));
  assert.equal(seed.products.length,678);assert.equal(new Set(seed.products.map(p=>p.sku)).size,678);
  assert.deepEqual(report.problems,[]);assert.equal(report.stockTotal,67800);
  assert.ok(seed.products.every(p=>Number.isInteger(p.price_cents)&&p.stock===100&&p.min_quantity===3));
  assert.equal(seed.delivery.shipping_cents,390);assert.equal(seed.delivery.free_threshold_cents,5000);
});

test('local comparison reports differences without accepting preview accounts or orders',()=>{
  const products=seed.products.map(p=>({id:p.id,sku:p.sku,name:p.name,brand:p.brand,category:p.category_id,keywords:p.keywords,status:p.status,featured:p.featured,description:p.description,image:p.image_url,original:p.original_image_url,r2:p.r2_image_url,variants:[{sku:p.sku,name:p.variant_name,price:p.price_cents,stock:p.stock,min:p.min_quantity,image:p.image_url}]}));
  const data={format:'cpvaluemart-business-export-v1',products,settings:{shipping:390,threshold:5000},coupons:seed.coupons.map(c=>({code:c.code,type:c.kind,amount:c.amount,min:c.minimum_cents,active:c.active}))};
  let result=compareExport(data);assert.deepEqual(result.changed,[]);assert.deepEqual(result.missing,[]);assert.equal(result.homepageChanged,false);assert.equal(result.couponsChanged,false);
  data.products[0].variants[0].price++;
  result=compareExport(data);assert.deepEqual(result.changed,[{sku:'13M-01-01',fields:['price_cents']}]);
  assert.equal(result.action,'Review only. No database changes are made.');
});
