// Read-only public catalog plus unauthenticated rejection checks; never creates orders.
import assert from 'node:assert/strict';
const base=process.argv[2];
const previewWithoutPayments=process.argv.includes('--preview-without-payments');
assert.ok(!previewWithoutPayments||base==='https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev');
let paymentConfiguration='present';
assert.ok(['https://cpvaluemart.com','https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev'].includes(base),'Use the known production or existing Preview origin.');
const get=async path=>{const response=await fetch(base+path,{redirect:'error',signal:AbortSignal.timeout(15000)});assert.equal(response.status,200,path);return response.json();};
const health=await get('/api/health');assert.equal(health.ok,true);
const [categories,config,brands]=await Promise.all([get('/api/categories'),get('/api/config'),get('/api/brands')]);
assert.ok(categories.categories.length>0);assert.ok(config.delivery.length>0);assert.ok(Array.isArray(brands.brands));
const first=await get('/api/products?size=100');const products=[...first.products];
for(let page=2;page<=first.pagination.totalPages;page++)products.push(...(await get('/api/products?size=100&page='+page)).products);
assert.equal(products.length,first.pagination.total);assert.equal(new Set(products.map(p=>p.sku)).size,products.length);
for(const p of products){assert.ok(Number.isSafeInteger(p.price_cents)&&p.price_cents>0);assert.ok(p.available_quantity>=0);assert.ok(/^https:\/\//.test(p.image_url));}
const detail=await get('/api/products/'+encodeURIComponent(products[0].sku));assert.equal(detail.product.sku,products[0].sku);
const imageUrls=[...new Set((process.argv.includes('--all-images')?products:products.slice(0,1)).map(p=>p.image_url))];
let imageCursor=0;
await Promise.all(Array.from({length:Math.min(8,imageUrls.length)},async()=>{
 while(imageCursor<imageUrls.length){const url=imageUrls[imageCursor++];const image=await fetch(url,{method:'HEAD',signal:AbortSignal.timeout(15000)});assert.equal(image.status,200,'R2 image unavailable');assert.match(image.headers.get('content-type'),/^image\//);}
}));
const source=await (await fetch(base+'/shop.js')).text();assert.ok(source.includes('TEST PAYMENTS ONLY'));assert.ok(source.includes('Checkout is restricted to approved testers'));
for(const path of ['/api/orders','/api/admin/orders','/api/admin/products','/api/admin/search','/api/admin/categories'])assert.equal((await fetch(base+path)).status,401,path);
for(const path of ['/api/checkout/session','/api/admin/order-actions']){
 const response=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});assert.ok(response.status===401||previewWithoutPayments&&response.status===503,path+' '+response.status);if(response.status===503)paymentConfiguration='missing-preview-secrets';
}
for(const path of ['/api/stripe/webhook','/api/resend/webhook']){
 const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.ok(response.status===400||previewWithoutPayments&&response.status===503,path+' '+response.status);if(response.status===503)paymentConfiguration='missing-preview-secrets';
}
console.log(JSON.stringify({origin:base,health:true,products:products.length,categories:categories.categories.length,brands:brands.brands.length,r2Image:true,r2ImagesVerified:imageUrls.length,checkoutUnauthenticated:'rejected',adminUnauthenticated:'rejected',paymentConfiguration,unsignedWebhooks:paymentConfiguration==='present'?'rejected':'unverified-missing-preview-secrets',testPaymentBanner:true}));
