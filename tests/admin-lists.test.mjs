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
 const old=state.orders;
 try{
  state.orders=Array.from({length:125},(_,i)=>({id:'CVM-'+i,date:'2026-11-20',name:'QA',email:'qa@example.invalid',status:'Processing',tracking:'',items:[],totals:{total:100}}));
  const html=adminPage('orders',undefined,new URLSearchParams('size=50&page=2&group=quarter&sort=oldest'));
  assert.match(html,/>Orders<\/a>/);assert.match(html,/Showing 51–100 of 125 orders/);
  assert.match(html,/2026 Q4/);assert.match(html,/data-order-groups="expand"/);assert.match(html,/data-order-groups="collapse"/);
  assert.equal((html.match(/>Open ↗<\/a>/g)||[]).length,50);
  assert.match(html,/origin=orders/);assert.match(html,/sort=oldest/);
 }finally{state.orders=old;}
});
