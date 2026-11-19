import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {state} from '../dist/store.js';
import {card,cart,checkout,confirmation,detail} from '../dist/shop.js';

test('guests cannot add products to a browser basket',()=>{
 const product=state.products.find(row=>row.status==='Published'&&row.variants[0].stock>=row.variants[0].min);
 state.account=null;
 const cardHtml=card(product,{quickAdd:true});
 const detailHtml=detail(product,new URLSearchParams());
 assert.doesNotMatch(cardHtml,/data-quick-add/);
 assert.match(cardHtml,/Sign in to add/);
 assert.doesNotMatch(detailHtml,/id="add-to-cart"/);
 assert.match(detailHtml,/Sign in to add to basket/);
 assert.match(cart(),/Sign in to your account/);
});

test('member shopping startup discards legacy guest cart instead of merging it',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 const sync=source.match(/async function syncShopping\(\) \{[\s\S]*?\n\}/)?.[0]??'';
 assert.match(sync,/state\.cart=\{\};state\.saved=\[\];state\.recentlyViewed=\[\];\n  save\(\);/);
 assert.doesNotMatch(sync,/action:'merge'/);
 assert.match(source,/throw Error\('Sign in to add products to your basket\.'\)/);
 assert.match(source,/let shoppingOwner,shoppingLoading=false/);
 assert.match(source,/privateBuyerRoutes=new Set\(\['\/cart'/);
 assert.match(source,/\^\\\/product\\\//);
});

test('checkout uses only a saved address and labels Stripe sandbox clearly',()=>{
 const product=state.products.find(row=>row.status==='Published'&&row.variants[0].stock>=row.variants[0].min);
 state.account={id:'test',email:'buyer@example.invalid',name:'Buyer'};
 state.cart={[product.id]:product.variants[0].min};
 const html=checkout([{id:'88888888-8888-4888-8888-888888888888',full_name:'Buyer',address_line:'Saved address',postal_code:'000001',is_default:true}]);
 assert.match(html,/Stripe sandbox only/);assert.match(html,/Stripe test checkout/);assert.match(html,/name="addressId"/);
 assert.doesNotMatch(html,/name="address"/);assert.doesNotMatch(html,/card number/i);
});

test('Stripe return page waits for the signed webhook instead of claiming final payment state',()=>{
 const html=confirmation(new URLSearchParams('session_id=cs_test_123'));
 assert.match(html,/signed webhook is processed/);assert.doesNotMatch(html,/payment successful/i);
});

test('Stripe return refreshes the member cart until the signed webhook is visible',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 assert.match(source,/async function refreshCheckoutReturn\(sessionId\)/);
 assert.match(source,/Promise\.all\(\[loadMemberShopping\(\),loadOrders\(\)\]\)/);
 assert.match(source,/case 'confirmation':[\s\S]*refreshCheckoutReturn\(params\.get\('session_id'\)\)/);
});
