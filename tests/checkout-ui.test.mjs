import {test} from 'node:test';
import assert from 'node:assert/strict';
import {state} from '../dist/store.js';
import {checkout,confirmation} from '../dist/shop.js';

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
