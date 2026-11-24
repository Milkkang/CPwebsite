import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {state} from '../dist/store.js';
import {account,card,cart,checkout,confirmation,detail,info,orders,shopFrame} from '../dist/shop.js';

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

test('guests are sent to sign in instead of saving items locally',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 const handler=source.match(/else if\('save' in data\) \{[\s\S]*?\n  \}/)?.[0]??'';
 assert.match(handler,/return navigate\('\/account',\{next:location\.hash\.slice\(1\)\|\|'\/saved'\}\)/);
 assert.doesNotMatch(handler,/state\.saved\s*=/);
});

test('only approved accounts see a checkout form with a no-charge notice',()=>{
 const product=state.products.find(row=>row.status==='Published'&&row.variants[0].stock>=row.variants[0].min);
 state.account={id:'test',email:'buyer@example.invalid',name:'Buyer',checkoutEmail:'pay@example.invalid'};
 state.cart={[product.id]:product.variants[0].min};
 assert.match(checkout([],false),/Online ordering is currently unavailable/);
 assert.doesNotMatch(checkout([],false),/checkout-form|Continue to Stripe/);
 assert.match(checkout([],null),/Checking availability/);
 const html=checkout([{id:'88888888-8888-4888-8888-888888888888',full_name:'Buyer',address_line:'1 Example Road\n#03-04',postal_code:'000001',is_default:true}],true);
 assert.match(html,/This order is simulated. You will not be charged/);assert.match(html,/Continue to Stripe/);assert.match(html,/name="addressId"/);
 assert.match(html,/<strong>Buyer<\/strong><span>pay@example\.invalid<\/span><span>1 Example Road<\/span><span>#03-04<\/span><span>Singapore 000001<\/span>/);
 assert.doesNotMatch(html,/name="address"/);assert.doesNotMatch(html,/card number/i);
});

test('the account offers its welcome coupon and the basket displays the server quote',()=>{
 const previous={account:state.account,cart:state.cart,coupon:state.coupon};
 try {
  const product=state.products.find(row=>row.status==='Published');
  state.account={id:'member',email:'member@example.invalid',name:'Member',verified:true};
  state.cart={[product.id]:1};
  state.coupon='';
  const membership={enabled:true,member:true,welcome:{status:'available',discount:300,minimum:5000,expiresAt:'2026-12-24T00:00:00Z'}};
  const selected={selected:true,quote:{subtotal:5000,shipping:0,discount:300,total:4700}};
  assert.match(account(new URLSearchParams(),membership),/Membership centre[\s\S]*S\$3\.00 off S\$50\.00[\s\S]*24 Dec 2026/);
  assert.doesNotMatch(account(new URLSearchParams(),{...membership,enabled:false}),/Membership centre/);
  assert.match(cart(null,{membership}),/Use welcome coupon/);
  assert.match(cart(null,{membership,...selected}),/Remove welcome coupon/);
  assert.match(cart(null,{membership,...selected}),/−S\$3\.00[\s\S]*S\$47\.00/);
  const addresses=[{id:'sample',full_name:'Member',address_line:'Example',postal_code:'112233',is_default:true}];
  assert.match(checkout(addresses,true,{benefits:{selected:true}}),/disabled>Continue to Stripe/);
  assert.match(checkout(addresses,true,{benefits:selected}),/−S\$3\.00[\s\S]*S\$47\.00/);
 } finally {Object.assign(state,previous);}
});

test('Stripe return page waits for the signed webhook instead of claiming final payment state',()=>{
 const html=confirmation(new URLSearchParams(),{status:'checking'});
 assert.match(html,/waiting for payment confirmation from Stripe/);assert.doesNotMatch(html,/payment confirmed/i);
});

test('Stripe return refreshes the member cart until the signed webhook is visible',async()=>{
 const source=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
 assert.match(source,/async function refreshCheckoutReturn\(sessionId\)/);
 assert.match(source,/Promise\.allSettled\(\[loadMemberShopping\(\),loadOrders\(\)\]\)/);
 assert.match(source,/\/api\/checkout\/status/);
 assert.match(source,/history\.replaceState\(\{\.\.\.history\.state,checkoutSession\},'','#\/confirmation'\)/);
 assert.match(source,/const sessionId=history\.state\?\.checkoutSession/);
 assert.match(source,/case 'confirmation':[\s\S]*refreshCheckoutReturn\(returnSession\)/);
});

test('pending orders are visible in purchase history and excluded from To Ship',()=>{
 const previous={account:state.account,orders:state.orders};
 try {
  const email='buyer@example.invalid';
  state.account={email};
  const order={email,status:'Processing',date:'2026-11-24',items:[],totals:{total:500}};
  state.orders=[{...order,id:'CVM-PENDING',paymentStatus:'pending'},{...order,id:'CVM-PAID',paymentStatus:'paid'}];
  const tracking=orders(new URLSearchParams('view=receive&stage=to-ship'));
  assert.match(tracking,/CVM-PAID/);
  assert.doesNotMatch(tracking,/CVM-PENDING/);
  assert.match(orders(),/CVM-PENDING.*Payment pending/);
 } finally {Object.assign(state,previous);}
});

test('admin order loading includes email audit status and a controlled resend action',async()=>{
 const [app,admin]=await Promise.all([readFile(new URL('../dist/app.js',import.meta.url),'utf8'),readFile(new URL('../dist/admin.js',import.meta.url),'utf8')]);
 assert.match(app,/authRequest\('\/api\/admin\/email-jobs'\)/);assert.match(app,/action:'resend',jobId:data\.resendEmail/);
 assert.match(admin,/Transactional email/);assert.match(admin,/\['failed','bounced'\]\.includes\(job\.status\)/);
 assert.doesNotMatch(admin,/complained'\]\.includes/);
});

test('public storefront copy removes preview wording and directs enquiries to customer care',()=>{
 const html=shopFrame(['faq','terms','privacy','delivery','contact'].map(info).join(''));
 assert.doesNotMatch(html,/\b(test|sandbox|demo|demonstration)\b/i);
 assert.match(html,/mailto:hello@cpvaluemart\.com/);
 assert.doesNotMatch(html,/contact-form/);
});

test('public page metadata uses storefront copy and starts without sample promotions',async()=>{
 for(const file of ['index.html','404.html']){
  const html=await readFile(new URL('../dist/'+file,import.meta.url),'utf8');
  const description=html.match(/<meta name="description" content="([^"]+)"/)?.[1];
  assert.match(description,/CP Value Mart in Singapore/);
  assert.doesNotMatch(description,/\b(test|demo|sandbox|preview)\b/i);
 }
 assert.deepEqual(state.coupons,[]);
});
