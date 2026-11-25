import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listPage,groupOrders,orderDay} from '../dist/admin-lists.js';
import {adminPage} from '../dist/admin.js';
import {state} from '../dist/store.js';
test('list paging handles page sizes, boundaries and invalid input',()=>{
 for(const size of [30,50,100]){
  const p=listPage(new URLSearchParams({size,page:'999'}),125);
  assert.equal(p.size,size);assert.equal(p.page,Math.ceil(125/size));assert.ok(p.start<125);
 }
 assert.deepEqual(listPage(new URLSearchParams('size=31&page=-1'),0),{size:30,pages:1,page:1,start:0});
});
test('calendar order groups use Singapore dates, Monday weeks and calendar quarters',()=>{
 const rows=[{id:'CVM-2',createdAt:'2026-12-31T17:00:00Z'},{id:'CVM-1',createdAt:'2026-12-31T10:00:00Z'}];
 assert.equal(orderDay(rows[0]),'2027-01-01');
 assert.deepEqual(groupOrders(rows,'quarter').map(g=>g.label),['2027 Q1','2026 Q4']);
 assert.deepEqual(groupOrders(rows,'year','oldest').map(g=>g.label),['2026','2027']);
 assert.equal(groupOrders(rows,'week')[0].label,'Week of 2026-12-28');
 assert.deepEqual(groupOrders(rows,'month').map(g=>g.label),['January 2027','December 2026']);
 assert.deepEqual(rows.map(r=>r.id),['CVM-2','CVM-1']);
});
test('products show only selected page rows and preserve filters in pagination',()=>{
 const old=state.products;
 try{
  state.products=Array.from({length:125},(_,i)=>({id:'QA-'+i,sku:'QA-'+i,name:'Fixture '+i,brand:'QA',category:'others',status:'Published',image:'',variants:[{sku:'QA-'+i,name:'Standard',price:100,stock:5,min:1}]}));
  for(const size of [30,50,100]){
   const html=adminPage('products',undefined,new URLSearchParams({size}));
   assert.equal((html.match(/class="product-row-start"/g)||[]).length,size);
   assert.match(html,/Products per page/);
  }
  const html=adminPage('products',undefined,new URLSearchParams('size=30&page=2&status=Published&q=Fixture'));
  assert.match(html,/Showing 31–60 of 125 products/);assert.match(html,/page=3/);assert.match(html,/status=Published/);
 }finally{state.products=old;}
});
test('Orders is a dedicated paged tab with group controls and contextual detail links',()=>{
 const old=state.adminOrders;
 try{
  state.adminOrders=Array.from({length:125},(_,i)=>({id:'CVM-'+i,date:'2026-11-20',name:'QA',email:'qa@example.invalid',status:'Processing',tracking:'',items:[],totals:{total:100}}));
  const html=adminPage('orders',undefined,new URLSearchParams('size=50&page=2&group=quarter&sort=oldest'));
  assert.match(html,/>Orders<\/a>/);assert.match(html,/Showing 51–100 of 125 orders/);
  assert.match(html,/2026 Q4/);assert.match(html,/data-order-groups="expand"/);assert.match(html,/data-order-groups="collapse"/);
  assert.equal((html.match(/>Open ↗<\/a>/g)||[]).length,50);
  assert.match(html,/origin=orders/);assert.match(html,/sort=oldest/);
 }finally{state.adminOrders=old;}
});
test('date filtering and monthly test sales exclude cancelled and unpaid orders',()=>{
 const old=state.adminOrders;
 try{
  state.adminOrders=[
   {id:'CVM-1',backendId:'shipment-1',date:'2026-11-20',createdAt:'2026-11-20T02:00:00Z',name:'QA',email:'qa@example.invalid',status:'Shipped',paymentStatus:'paid',items:[],totals:{total:1250}},
   {id:'CVM-2',date:'2026-11-20',createdAt:'2026-11-20T01:00:00Z',name:'QA',email:'qa@example.invalid',status:'Cancelled',paymentStatus:'paid',items:[],totals:{total:2000}},
   {id:'CVM-3',date:'2026-10-19',createdAt:'2026-10-19T01:00:00Z',name:'QA',email:'qa@example.invalid',status:'Processing',paymentStatus:'pending',items:[],totals:{total:3000}}
  ];
  const orders=adminPage('orders',undefined,new URLSearchParams('from=2026-11-20&to=2026-11-20'));
  assert.match(orders,/Showing 1–2 of 2 orders/);assert.doesNotMatch(orders,/CVM-3/);
  const shipped=adminPage('orders',undefined,new URLSearchParams('status=Shipped'));
  assert.match(shipped,/data-open-bulk-order="deliver"/);
  assert.match(shipped,/Mark selected as delivered/);
  assert.match(shipped,/<p>1 order · Singapore time<\/p>/);
  assert.doesNotMatch(shipped,/<header[^>]*>[\s\S]*?(?:\btest\b|simulated)[\s\S]*?<\/header>/i);
  assert.match(shipped,/data-select-order value="shipment-1"/);
  assert.doesNotMatch(shipped,/data-open-bulk-order="ship"/);
  const revenue=adminPage('revenue',undefined,new URLSearchParams('year=2026'));
  assert.equal((revenue.match(/class="sales-month"/g)||[]).length,12);
  assert.match(revenue,/1 simulated order · S\$12\.50/);
  assert.match(revenue,/\/admin\/orders\?from=2026-11-20&amp;to=2026-11-20/);
  assert.doesNotMatch(revenue,/S\$20\.00|S\$30\.00/);
 }finally{state.adminOrders=old;}
});

test('customer order value uses paid live sales and the order link filters by exact email',()=>{
 const previous=state.adminOrders;
 try {
  const row={name:'Fixture',email:'buyer+shop@example.invalid',status:'Processing',livePayment:true,paymentStatus:'paid',date:'2026-11-24',items:[],totals:{total:500}};
  state.adminOrders=[
   {...row,id:'CVM-LIVE'},
   {...row,id:'CVM-SIMULATED',livePayment:false},
   {...row,id:'CVM-PENDING',paymentStatus:'pending'},
   {...row,id:'CVM-REFUNDED',paymentStatus:'refunded'},
   {...row,id:'CVM-CANCELLED',status:'Cancelled'},
   {...row,id:'CVM-OTHER',email:'otherbuyer+shop@example.invalid'}
  ];
  const customers=adminPage('customers',undefined,new URLSearchParams());
  assert.match(customers,/buyer\+shop@example\.invalid<\/td><td>5<\/td><td>S\$5\.00/);
  assert.match(customers,/#\/admin\/orders\?customer=buyer%2Bshop%40example\.invalid/);
  const orders=adminPage('orders',undefined,new URLSearchParams({customer:row.email}));
  assert.match(orders,/CVM-LIVE/);
  assert.match(orders,/CVM-PENDING/);
  assert.doesNotMatch(orders,/CVM-OTHER/);
 } finally {state.adminOrders=previous;}
});

test('order detail limits item returns to remaining quantities and shows recorded refunds',()=>{
 const old=state.adminOrders;
 try{
  const order={id:'CVM-501',date:'2026-11-24',status:'Delivered',paymentStatus:'paid',livePayment:true,
   refundedCents:1800,totals:{total:4500},items:[
    {sku:'A',name:'Fixture A',option:'One',price:2000,qty:1,refundedQty:1},
    {sku:'B',name:'Fixture B',option:'One',price:1500,qty:2,refundedQty:1}
   ]};
  state.adminOrders=[order];
  let html=adminPage('orders',order.id,new URLSearchParams());
  assert.doesNotMatch(html,/data-refund-sku="A"/);
  assert.match(html,/max="1"[^>]+data-refund-sku="B"/);
  assert.match(html,/data-order-action="refund_items"/);
  assert.match(html,/Refunded quantity 1/);
  assert.match(html,/Refunded <strong>S\$18\.00/);
  order.pendingRefund={requestId:'fixture',items:[{sku:'B',quantity:1}],amount:900,restock:false};
  html=adminPage('orders',order.id,new URLSearchParams());
  assert.match(html,/Retry refund/);
  assert.doesNotMatch(html,/data-order-action="refund_items"/);
 }finally{state.adminOrders=old;}
});
