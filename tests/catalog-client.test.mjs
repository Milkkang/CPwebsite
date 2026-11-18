import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listingFromApi,catalogQuery} from '../dist/catalog-client.js';

test('published database listing retains price, available stock, MOQ and R2 images',()=>{
  const product=listingFromApi({sku:'SKU_1',name:'Example',variant_name:'2 pack',brand:'Brand',category_id:'paper-tissues',
    description:'Description',keywords:'tissues',status:'Published',featured:true,
    image_url:'https://example.com/image.webp',original_image_url:'https://example.com/original.webp',
    r2_image_url:'https://example.com/r2.webp',price_cents:499,stock:50,available_quantity:3,min_quantity:2,version:4});
  assert.equal(product.id,'SKU_1');
  assert.equal(product.variants[0].stock,3);
  assert.equal(product.variants[0].min,2);
  assert.equal(product.variants[0].price,499);
  assert.equal(product.r2,'https://example.com/r2.webp');
  assert.equal(product.version,4);
});

test('catalog query passes server filters and page size',()=>{
  const url=new URL(catalogQuery(new URLSearchParams('q=soap&brand=Acme&sort=price-up&size=50&page=2'),'skin-care'),'https://cpvaluemart.com');
  assert.equal(url.pathname,'/api/products');
  assert.deepEqual(Object.fromEntries(url.searchParams),{q:'soap',brand:'Acme',sort:'price-up',size:'50',page:'2',category:'skin-care'});
});
