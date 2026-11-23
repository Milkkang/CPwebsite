import {listPage,groupOrders} from './admin-lists.js';
import {state,save,cash,escape as e,categoryName,categories,statusList,updateOrder,imageUrl,findProduct,orderDate,homepageSettings} from './store.js';
import {go,link,href,badge,selected,checked,photo,empty,orderDisplay,productLabel,orderItemsPreview} from './shop.js';
import {overviewAnalytics,revenueMetric,revenueAnalytics} from './analytics.js';

const nav=[['','Overview'],['revenue','Revenue'],['orders','Orders'],['products','Products'],['homepage','Homepage'],['customers','Customers'],['coupons','Coupons'],['search','Search insights'],['settings','Settings']];
export function adminFrame(page,body) {
  return '<header class="admin-top"><div class="wrap"><a class="logo" href="#/admin"><span class="mark" aria-hidden="true"></span><span>CP Value Mart <b>Admin</b></span></a><div class="button-row"><span class="badge status-draft">Stripe test orders</span>'+go('/','View storefront ↗','btn outline small')+'</div></div></header>'+
    '<div class="wrap admin-layout"><aside class="admin-nav"><nav aria-label="Admin">'+nav.map(([k,n])=>go('/admin'+(k?'/'+k:''),n,k===page?'active':'')).join('')+'</nav></aside><main class="admin-main" id="main">'+body+'</main></div>';
}
const heading=(title,subtitle='',actions='')=>'<div class="admin-heading"><div><h1>'+title+'</h1>'+(subtitle?'<p>'+subtitle+'</p>':'')+'</div><div class="button-row">'+actions+'</div></div>';
const table=(headers,rows)=>'<div class="panel table-wrap"><table><thead><tr>'+headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
const field=(label,name,value,options='')=>'<label>'+label+'<input name="'+name+'" value="'+e(value)+'" '+options+'></label>';
const amountInput=(label,name,cents)=>field(label,name,(cents/100).toFixed(2),'type="number" min="0" max="99999" step="0.01" required');
const moneyToCents=value=>Math.round(Number(value)*100);
const opts=(values,value)=>values.map(v=>'<option'+selected(v,value)+'>'+e(v)+'</option>').join('');
const cats=value=>categories.map(([id,name])=>'<option value="'+id+'"'+selected(id,value)+'>'+e(name)+'</option>').join('');
const editHref=(p,params)=>href('/admin/products/'+p.id,Object.fromEntries(params));

const periods=[
  ['1d','1 day'],['1w','1 week'],['1m','1 month'],['3m','3 months'],['1y','1 year']
];
const periodMonths={'1m':1,'3m':3,'1y':12};
export function orderPeriod(range,today=orderDate()) {
  const start=new Date(today+'T00:00:00Z');
  if(range==='1w') start.setUTCDate(start.getUTCDate()-6);
  if(Object.hasOwn(periodMonths,range)) {
    const day=start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth()-periodMonths[range]);
    const lastDay=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate();
    start.setUTCDate(Math.min(day,lastDay)+1);
  }
  return {from:start.toISOString().slice(0,10),to:today};
}
export function revenueDateError(from,to,today=orderDate()) {
  const isDate=value=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value??'')) return false;
    const date=new Date(value+'T00:00:00Z');
    return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
  };
  if(!isDate(from)||!isDate(to)) return 'Choose a start and end date.';
  if(from>to) return 'Start date must be on or before end date.';
  if(to>today) return 'End date must be today or earlier.';
}
function revenueSelection(params,today=orderDate()) {
  const requested=params.get('range');
  const from=params.get('from'), to=params.get('to');
  const dateError=requested==='custom'?revenueDateError(from,to,today):undefined;
  const custom=requested==='custom'&&!dateError;
  const range=custom?'custom':periods.some(([key])=>key===requested)?requested:'1m';
  const period=custom?{from,to}:orderPeriod(range,today);
  const orders=state.adminOrders.filter(o=>o.date>=period.from&&o.date<=period.to).sort((a,b)=>b.date.localeCompare(a.date));
  return {range,period,orders,dateError};
}
const orderRevenue=()=>0;
function revenuePage(params) {
  const today=orderDate();
  const {range,period,orders,dateError}=revenueSelection(params,today);
  const metric=revenueMetric(params.get('metric'));
  const filters={range,...(range==='custom'?period:{})};
  return heading('Revenue','TEST MODE: all orders are simulated. Real revenue is S$0.00.',
    '<button type="button" class="btn primary" data-export="revenue">Generate Report</button>')+
    '<section class="panel revenue-period" aria-labelledby="revenue-period-title"><div class="section-title"><h2 id="revenue-period-title">Date range</h2><span class="subtle">Singapore time</span></div>'+
    '<nav class="period-options" aria-label="Revenue date presets">'+periods.map(([key,label])=>
      '<a class="btn small '+(key===range?'chosen':'outline')+'" href="'+e(href('/admin/revenue',{range:key,metric:metric.key}))+'"'+(key===range?' aria-current="true"':'')+'>'+label+'</a>'
    ).join('')+'</nav>'+
    '<form class="admin-filters revenue-date-form" id="revenue-period-form"><input type="hidden" name="metric" value="'+metric.key+'">'+
    field('From','from',period.from,'type="date" max="'+today+'" required')+
    field('To','to',period.to,'type="date" max="'+today+'" required')+
    '<button class="btn outline">Apply dates</button></form>'+
    (dateError?'<p class="notice" role="status">'+e(dateError)+' Showing the last month.</p>':'')+'</section>'+
    revenueAnalytics(period,orders,filters,metric)+
    '<p class="subtle revenue-note">Based on completed Stripe test payments only. Test revenue is not real business revenue. Cancelled orders are excluded.</p>'+
    testSalesCalendar(params);
}
function testSalesCalendar(params){
 const currentYear=Number(orderDate().slice(0,4));
 const years=[...new Set([currentYear,...state.adminOrders.map(o=>Number(o.date.slice(0,4)))])].filter(Number.isSafeInteger).sort((a,b)=>b-a);
 const requested=Number(params.get('year'));
 const year=years.includes(requested)?requested:currentYear;
 const monthNames=Array.from({length:12},(_,i)=>new Intl.DateTimeFormat('en-SG',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(year,i,1))));
 const paid=state.adminOrders.filter(o=>o.paymentStatus==='paid'&&o.status!=='Cancelled'&&o.date.startsWith(String(year)));
 const byDay=new Map();
 for(const order of paid){const day=byDay.get(order.date)??{count:0,total:0};day.count++;day.total+=order.totals.total;byDay.set(order.date,day);}
 const months=monthNames.map((name,index)=>{
  const prefix=year+'-'+String(index+1).padStart(2,'0');
  const days=[...byDay.entries()].filter(([day])=>day.startsWith(prefix)).sort(([a],[b])=>b.localeCompare(a));
  const total=days.reduce((sum,[,day])=>sum+day.total,0);
  const count=days.reduce((sum,[,day])=>sum+day.count,0);
  return '<details class="sales-month"'+(year===currentYear&&index===Number(orderDate().slice(5,7))-1?' open':'')+'><summary><strong>'+name+'</strong><span>'+count+(count===1?' test order':' test orders')+' · '+cash(total)+'</span></summary>'+
   (days.length?table(['Day','Completed test orders','Test sales total'],days.map(([date,day])=>'<tr><td>'+link(href('/admin/orders',{from:date,to:date,group:'day'}),e(date),'text-link')+'</td><td>'+day.count+'</td><td>'+cash(day.total)+'</td></tr>').join('')):'<p class="subtle">No completed test sales.</p>')+'</details>';
 }).join('');
 return '<div class="section-title admin-section"><h2>Sales <small class="subtle">(test mode)</small></h2><form id="sales-year-form"><label>Year <select name="year">'+years.map(value=>'<option value="'+value+'"'+selected(value,year)+'>'+value+'</option>').join('')+'</select></label></form></div>'+
  '<p class="subtle">Completed Stripe test payments only; cancelled orders are excluded. These totals are not business revenue. Select a day to view all orders for that date.</p>'+months;
}
function overview(params) {
  const range=periods.some(([key])=>key===params.get('range'))?params.get('range'):'1m';
  const metric=params.get('metric')??'sales';
  const filters={range,metric};
  const {from,to}=orderPeriod(range);
  const periodOrders=state.adminOrders.filter(o=>o.date>=from&&o.date<=to);
  const valid=periodOrders.filter(o=>o.status!=='Cancelled');
  const traffic=state.traffic?.filter(row=>row.day>=from&&row.day<=to)??[];
  return heading('Overview','TEST MODE · Simulated orders; real revenue S$0.00.',go('/admin/products/new','Add product','btn primary'))+
    '<div class="period-control"><nav class="period-options" aria-label="Order date range">'+periods.map(([key,label])=>
      '<a class="btn small '+(key===range?'chosen':'outline')+'" href="'+e(href('/admin',{...filters,range:key}))+'"'+(key===range?' aria-current="true"':'')+'>'+label+'</a>'
    ).join('')+'</nav><p class="subtle">'+(from===to?to:from+' to '+to)+'</p></div>'+
    overviewAnalytics({from,to},filters,valid,metric,traffic)+
    '<div class="section-title admin-section"><h2>Website traffic</h2><span class="subtle">Singapore time</span></div>'+
    (state.traffic===null?'<div class="panel"><p role="status">Traffic counts are temporarily unavailable. '+e(state.trafficError??'')+'</p></div>':
      table(['Date','Visitor sessions','Add-to-cart sessions'],traffic.slice().sort((a,b)=>b.day.localeCompare(a.day)).map(row=>'<tr><td>'+e(row.day)+'</td><td>'+Number(row.visit_sessions)+'</td><td>'+Number(row.cart_sessions)+'</td></tr>').join('')||'<tr><td colspan="3">Tracking has started; no visits recorded in this period yet.</td></tr>'))+salesTables(valid)+
    '<div class="section-title admin-section"><h2>Quick actions</h2></div><div class="quick-grid">'+go('/admin/products','Manage products and images ↗','panel')+link(href('/admin/products',{low:'1'}),'Review low stock ↗','panel')+go('/admin/search','Inspect search terms ↗','panel')+'</div>';
}
const productSearch = (q='',mode='') => state.products.filter(p=>{
  const text=[p.name,p.brand,p.sku,categoryName(p.category),...p.variants.map(v=>v.sku)].join(' ').toLowerCase();
  return text.includes(q.toLowerCase())&&(!mode||p.status===mode);
});
function pageSize(size,label){
 return '<label>'+label+'<select name="size">'+[30,50,100].map(n=>'<option value="'+n+'"'+selected(n,size)+'>'+n+'</option>').join('')+'</select></label>';
}
function listPagination(path,params,paging,total,noun){
 const {size,pages,page,start}=paging;
 const pageLink=(n,label)=>link(href(path,{...Object.fromEntries(params),size,page:n}),label,'btn outline small');
 const numbers=[...new Set([1,pages,page-1,page,page+1].filter(n=>n>=1&&n<=pages))].sort((a,b)=>a-b);
 return '<nav class="catalog-pagination" aria-label="'+noun+' pages"><p>Showing '+(total?start+1:0)+'–'+Math.min(start+size,total)+' of '+total+' '+noun.toLowerCase()+' · Page '+page+' of '+pages+'</p><div class="pagination-links">'+
  (page>1?pageLink(page-1,'Previous'):'<span class="btn outline small" aria-disabled="true">Previous</span>')+
  numbers.map((n,i)=>(i&&n-numbers[i-1]>1?'<span aria-hidden="true">…</span>':'')+(n===page?'<span class="btn primary small" aria-current="page">'+n+'</span>':pageLink(n,String(n)))).join('')+
  (page<pages?pageLink(page+1,'Next'):'<span class="btn outline small" aria-disabled="true">Next</span>')+'</div></nav>';
}
function ordersPage(params,q){
 const status=params.get('status')??'';
 const from=params.get('from')??'',to=params.get('to')??'';
 const dateError=from||to?revenueDateError(from,to):'';
 const group=['day','week','month','quarter','year'].includes(params.get('group'))?params.get('group'):'day';
 const sort=params.get('sort')==='oldest'?'oldest':'newest';
 const rows=state.adminOrders.filter(o=>(o.id+' '+o.name+' '+o.email).toLowerCase().includes(q.toLowerCase())&&(!status||o.status===status)&&(dateError||!from||o.date>=from)&&(dateError||!to||o.date<=to));
 const sorted=groupOrders(rows,'day',sort).flatMap(g=>g.orders),paging=listPage(params,rows.length);
 const groups=groupOrders(sorted.slice(paging.start,paging.start+paging.size),group,sort);
 const filters={...Object.fromEntries(params),group,sort,size:paging.size,page:paging.page,origin:'orders'};
 const pagination=listPagination('/admin/orders',params,paging,rows.length,'Orders');
 return heading('Orders',rows.length+' orders · Singapore time · Test payments only','<button class="btn outline" data-export="orders">Export all orders</button>')+
  '<form class="admin-filters" id="admin-filter" data-path="/admin/orders">'+field('Find order','q',q,'placeholder="Order number or customer"')+
  '<label>Status<select name="status"><option value="">All statuses</option>'+opts(statusList,status)+'</select></label>'+
  field('From','from',from,'type="date"')+field('To','to',to,'type="date"')+
  '<label>Group by<select name="group">'+[['day','Day'],['week','Week'],['month','Month'],['quarter','Quarter'],['year','Year']].map(([key,label])=>'<option value="'+key+'"'+selected(key,group)+'>'+label+'</option>').join('')+'</select></label>'+
  '<label>Sort<select name="sort"><option value="newest"'+selected(sort,'newest')+'>Newest first</option><option value="oldest"'+selected(sort,'oldest')+'>Oldest first</option></select></label>'+
  pageSize(paging.size,'Orders per page')+'<button class="btn outline">Filter</button></form>'+(dateError?'<p class="notice" role="status">'+e(dateError)+' Showing all dates.</p>':'')+
  '<div class="button-row order-group-actions"><button type="button" class="btn outline small" data-order-groups="expand">Expand all</button><button type="button" class="btn outline small" data-order-groups="collapse">Collapse all</button></div>'+pagination+
  (groups.length?groups.map(g=>'<details class="order-date-group" open><summary>'+e(g.label)+' <span class="subtle">'+g.orders.length+(g.orders.length===1?' order':' orders')+' on this page</span></summary>'+ordersTable(g.orders,filters)+'</details>').join(''):empty('No matching orders','Adjust or clear the filters.'))+pagination;
}
function productList(params) {
  const q=params.get('q')??'', status=params.get('status')??'', low=params.get('low')==='1';
  const rows=productSearch(q,status).map(p=>({p,variants:low?p.variants.filter(v=>v.stock<=5):p.variants}))
    .filter(row=>row.variants.length);
  const paging=listPage(params,rows.length),pagination=listPagination('/admin/products',params,paging,rows.length,'Products');
  return heading('Products',rows.length+' of '+state.products.length+' products',
    '<button class="btn outline" data-export="products">Export CSV</button><button class="btn outline" data-export="template">Import template</button><label class="btn outline">Import CSV / Excel<input type="file" id="import-csv" accept=".csv,.xlsx" hidden></label>'+go('/admin/products/new','Add product','btn primary'))+
    '<p class="subtle import-hint">Edit variant name, price, MOQ or status directly; changes save when you leave the field.</p>'+
    '<form class="admin-filters" id="admin-filter" data-path="/admin/products">'+field('Find product','q',q,'placeholder="Name, brand or SKU"')+
    '<label>Status<select name="status"><option value="">All statuses</option>'+opts(['Published','Draft','Archived'],status)+'</select></label>'+
    '<label>Availability<select name="low"><option value="">All stock levels</option><option value="1"'+selected(low,true)+'>Low stock (5 or fewer)</option></select></label>'+pageSize(paging.size,'Products per page')+'<button class="btn outline">Filter</button></form>'+pagination+
    (!rows.length?empty('No matching products','Adjust or clear the product filters.'):
    table(['Product','Variant','Price (SGD)','Stock','MOQ','Status',''],rows.slice(paging.start,paging.start+paging.size).map(row=>productRows(row,params)).join('')))+pagination;
}
function productRows({p,variants},params) {
  const span=' rowspan="'+variants.length+'"';
  const product=productLabel(p,'<b>'+e(p.name)+'</b><small>'+e(p.brand)+' · '+e(p.sku)+'</small>'+
    '');
  return variants.map((v,i)=>'<tr class="'+(i===0?'product-row-start':'')+'">'+
    (i===0?'<td'+span+'>'+product+'</td>':'')+
    '<td><div class="admin-variant">'+photo(p,'variant-thumb',v)+'<div>'+inlineField('name',v.sku,v.name,'text','maxlength="60"')+'<small>'+e(v.sku)+'</small></div></div></td>'+
    '<td class="variant-number">'+inlineField('price',v.sku,(v.price/100).toFixed(2),'number','min="0" max="99999" step="0.01"')+'</td><td class="variant-stock"><span>'+v.stock+'</span><button type="button" class="btn outline small" data-stock="'+e(v.sku)+'" aria-label="Adjust stock for '+e(v.sku)+'">Adjust</button></td><td>'+inlineField('min',v.sku,v.min,'number','min="1" max="100000" step="1"')+'</td>'+
    (i===0?'<td'+span+'><select class="inline-status" data-inline-status="'+e(p.id)+'" aria-label="Status for '+e(p.name)+'">'+opts(['Published','Draft','Archived'],p.status)+'</select></td><td'+span+'>'+link(editHref(p,params),'Edit ↗','text-link')+'</td>':'')+'</tr>').join('');
}
const inlineField=(kind,sku,value,type,extra)=>'<input class="inline-edit inline-'+kind+'" type="'+type+'" data-inline="'+kind+'" data-sku="'+e(sku)+'" aria-label="'+({name:'Variant name',price:'Price in SGD',min:'Minimum quantity'}[kind])+' for '+e(sku)+'" value="'+e(value)+'" '+extra+' required>';
export function updateInlineProduct(kind,sku,value) {
  const row=state.products.find(p=>p.variants.some(v=>v.sku===sku));
  if(!row) return 'Product no longer exists.';
  const variant=row.variants.find(v=>v.sku===sku);
  const text=String(value).trim();
  if(kind==='name') {
    if(!text||text.length>60) return 'Enter a variant name of up to 60 characters.';
    const suffix=' · '+variant.name;
    if(row.name.endsWith(suffix)) row.name=row.name.slice(0,-suffix.length)+' · '+text;
    variant.name=text;
  } else if(kind==='price') {
    if(!/^\d+(?:\.\d{1,2})?$/.test(text)||Number(text)>99999) return 'Enter a valid price with up to two decimal places.';
    variant.price=moneyToCents(text);
  } else if(kind==='min') {
    const min=Number(text);
    if(!/^\d+$/.test(text)||min<1||min>100000) return 'Enter a valid minimum quantity.';
    variant.min=min;
  } else return 'Unknown field.';
  save();
}
export function updateInlineStatus(id,status) {
  const p=findProduct(id);
  if(!p) return 'Product no longer exists.';
  if(!['Published','Draft','Archived'].includes(status)) return 'Choose a valid status.';
  p.status=status;save();
}
function variantFields(v={},i=0,p={},allowRemove=true) {
  return '<fieldset class="variant-fields"><legend>Variant '+(i+1)+'</legend>'+(allowRemove?'<button type="button" class="btn outline small variant-remove" data-remove-variant aria-label="Delete variant '+(i+1)+'">Delete variant</button>':'')+'<input type="hidden" name="oldSku" value="'+e(v.sku??'')+'">'+
    field('Name','variantName',v.name??'','required maxlength="60"')+
    field('Variant SKU','variantSku',v.sku??'','required maxlength="32" pattern="[A-Za-z0-9_&#92;x2D]+"')+
    field('Price (SGD)','variantPrice',v.price===undefined?'':(v.price/100).toFixed(2),'type="number" min="0" max="99999" step="0.01" required')+
    field('Stock','variantStock',v.stock??'','type="number" min="0" max="100000" step="1" required')+
    field('Minimum qty','variantMin',v.min??'','type="number" min="1" max="100000" step="1" required')+
    '<div class="variant-image-field"><span data-variant-photo>'+photo(p,'thumb',v)+'</span>'+
    field('Variant image URL','variantImage',v.image??'','maxlength="350" placeholder="https://…"')+'</div></fieldset>';
}
export function productEditor(id,params=new URLSearchParams()) {
  const existing=findProduct(id);
  if(id!=='new'&&!existing) return empty('Product not found','Return to the product list.',go('/admin/products','View products','btn primary'));
  const p=existing??{sku:'',name:'',brand:'',category:'others',status:'Draft',description:'',keywords:'',image:'',original:'',r2:'',variants:[]};
  return link(href('/admin/products',Object.fromEntries(params)),'← Products','text-link')+heading(existing?'Edit product':'Add product',existing?e(p.sku):'Enter details and at least one variant.')+
    '<form id="product-editor" data-id="'+e(existing?.id??'')+'" data-version="'+e(existing?.version??0)+'" class="form-stack editor"><section class="panel form-stack"><h2>Product information</h2>'+(existing?productLabel(p,'<b>'+e(p.name)+'</b>'):'')+'<div class="field-grid">'+
    field('Product name','name',p.name,'required maxlength="500"')+field('Brand','brand',p.brand,'required maxlength="70"')+
    field('Parent SKU','sku',p.sku,'required maxlength="32" pattern="[A-Za-z0-9_&#92;x2D]+" '+(existing?'readonly':''))+
    '<label>Category<select name="category">'+cats(p.category)+'</select></label><label>Status<select name="status">'+opts(['Draft','Published','Archived'],p.status)+'</select></label>'+
    '<label class="check-label featured-field"><input type="checkbox" name="featured"'+checked(p.featured)+'> Feature on homepage</label></div>'+
    '<label>Description<textarea name="description" rows="3" maxlength="1000">'+e(p.description)+'</textarea></label>'+
    field('Search keywords','keywords',p.keywords,'maxlength="300" placeholder="English names, 中文 keywords, common abbreviations"')+
    field('R2 image URL','image',p.image,'maxlength="350" placeholder="https://…"')+'</section>'+
    '<section class="panel form-stack"><div class="section-title"><h2>Listing, stock and price</h2></div><p class="subtle">Each SKU is one listing. Enter the same SKU in both fields.</p><div id="variant-fields">'+(p.variants.length?p.variants:[{name:'',sku:'',price:0,stock:0,min:1,image:''}]).slice(0,1).map((v,i)=>variantFields(v,i,p,false)).join('')+'</div></section>'+
    '<p class="notice" data-product-status role="alert" hidden></p><div class="button-row"><button type="submit" class="btn primary" data-product-save>Save product</button>'+
    '<button type="button" class="btn outline" data-reload-product hidden>Reload latest product</button>'+go('/admin/products','Cancel','btn outline')+'</div></form>';
}
function ordersTable(rows,filters) {
  return table(['Order','Customer','Products','Date','Status','Total',''],rows.map(o=>'<tr><td><b>'+e(o.id)+'</b></td><td>'+e(o.name)+'</td><td>'+orderItemsPreview(o.items)+'</td><td>'+e(o.date)+'</td><td>'+badge(o.status)+'</td><td>'+cash(o.totals.total)+'</td><td>'+link(href('/admin/orders/'+(o.backendId??o.id),filters),'Open ↗','text-link')+'</td></tr>').join('')||'<tr><td colspan="7">No matching orders for this period.</td></tr>');
}
function orderEditor(id,params) {
  const o=state.adminOrders.find(o=>o.backendId===id||o.id===id);
  const {origin,...filters}=Object.fromEntries(params);
  const back=href(origin==='revenue'?'/admin/revenue':origin==='orders'?'/admin/orders':'/admin',filters);
  if(!o) return empty('Order not found','Return to the order list.',link(back,'View orders','btn primary'));
  const delivery=o.deliveryName?'<p>'+e(o.deliveryName)+'<br>'+e(o.address)+'<br>Singapore '+e(o.postal)+'</p>':
    '<p>Delivery address unavailable for this order.</p>';
  const emailJobs=o.emailJobs??[];
  const emailPanel='<section class="panel"><h2>Transactional email</h2><p class="subtle">Test recipients are restricted by the server allowlist.</p>'+
    (emailJobs.length?'<div class="table-wrap"><table><thead><tr><th>Type</th><th>Status</th><th>Recipient</th><th>Attempts</th><th></th></tr></thead><tbody>'+emailJobs.map(job=>
      '<tr><td>'+e(job.kind.replaceAll('_',' '))+'</td><td>'+badge(job.status)+'</td><td>'+e(job.recipient)+'</td><td>'+e(job.attempts)+'</td><td>'+(['failed','bounced'].includes(job.status)?'<button type="button" class="btn small outline" data-resend-email="'+e(job.id)+'">Resend</button>':'—')+'</td></tr>').join('')+'</tbody></table></div>':'<p>No email task has been queued for this order.</p>')+'</section>';
  return link(back,origin==='revenue'?'← Revenue order history':origin==='orders'?'← Orders':'← Overview orders','text-link')+heading(e(o.id),'Simulated payment · '+e(o.date))+'<div class="two-col">'+orderDisplay(o)+
    '<div class="form-stack"><section class="panel"><h2>Delivery address</h2>'+delivery+'<p>'+e(o.email)+'</p></section>'+
    '<form class="panel form-stack" id="order-editor" data-order="'+e(o.id)+'"><h2>Fulfilment</h2><label>Status<select name="status" '+(o.paymentStatus!=='paid'||o.status==='Cancelled'?'disabled':'')+'>'+opts(o.status==='Processing'?['Processing','Shipped']:o.status==='Shipped'?['Shipped','Delivered']:[o.status],o.status)+'</select></label>'+
    field('Courier tracking number','tracking',o.tracking,'maxlength="50" '+(o.status==='Cancelled'?'readonly':''))+
    '<div class="button-row">'+(o.status==='Processing'&&o.paymentStatus==='paid'?'<button type="submit" class="btn primary" name="ship-item">Ship Item</button>':'')+
    '<button type="submit" class="btn '+(o.status==='Processing'?'outline':'primary')+'" '+(o.paymentStatus!=='paid'||o.status==='Cancelled'?'disabled':'')+'>Save fulfilment</button></div></form>'+(['pending','paid'].includes(o.paymentStatus)?'<section class="panel form-stack"><h2>Test order operations</h2><p>No real funds are involved. A completed refund closes the order.</p><label class="check-label"><input type="checkbox" id="refund-restock"'+checked(o.status==='Processing')+'> Return items to stock (confirm items are available)</label><button type="button" class="btn outline" data-order-action="'+e(o.paymentStatus==='pending'?'cancel':'refund')+'" data-order-id="'+e(o.id)+'">'+(o.paymentStatus==='pending'?'Cancel unpaid test order':'Refund test payment')+'</button></section>':'')+emailPanel+'</div></div>';
}
function couponPage() {
  return heading('Coupons','Create and manage codes for the storefront.','<button class="btn primary" data-edit-coupon="">Add coupon</button>')+
    table(['Code','Type','Value','Min. subtotal','Status',''],state.coupons.map(c=>'<tr><td><b>'+e(c.code)+'</b></td><td>'+e(c.type==='shipping'?'Free delivery':c.type==='fixed'?'Fixed discount':'Percentage')+'</td><td>'+(c.type==='shipping'?'—':c.type==='fixed'?cash(c.amount):c.amount+'%')+'</td><td>'+cash(c.min)+'</td><td>'+badge(c.active?'Active':'Inactive')+'</td><td><button class="btn small outline" data-edit-coupon="'+e(c.code)+'">Edit</button></td></tr>').join('')||'<tr><td colspan="6">No coupons created.</td></tr>');
}
function customersPage() {
  const customers=new Map();
  for(const o of state.adminOrders) {
    const c=customers.get(o.email)??{name:o.name,email:o.email,orders:0,spend:0};
    c.orders++;
    if(o.status!=='Cancelled') c.spend+=o.totals.total;
    customers.set(o.email,c);
  }
  return heading('Customers',customers.size+' shopper profiles from Stripe test orders.')+
    table(['Customer','Email','Orders','Order value',''],[...customers.values()].map(c=>'<tr><td><b>'+e(c.name)+'</b></td><td>'+e(c.email)+'</td><td>'+c.orders+'</td><td>'+cash(c.spend)+'</td><td>'+link(href('/admin',{q:c.email,range:'1y'}),'View orders ↗','text-link')+'</td></tr>').join('')||'<tr><td colspan="5">No customer orders yet.</td></tr>');
}
function salesTables(orders) {
  const revenue=new Map(), products=new Map();
  for(const order of orders) {
    const day=revenue.get(order.date)??{orders:0,total:0};
    day.total+=order.totals.total; day.orders++;
    revenue.set(order.date,day);
    for(const item of order.items) {
      const product=products.get(item.productId)??{id:item.productId,name:item.name,units:0,total:0};
      product.units+=item.qty; product.total+=item.price*item.qty;
      products.set(item.productId,product);
    }
  }
  const days=[...revenue.entries()].sort(([a],[b])=>b.localeCompare(a));
  const top=[...products.values()].sort((a,b)=>b.units-a.units||b.total-a.total).slice(0,10);
  return '<div class="section-title admin-section"><h2>Simulated daily sales</h2></div>'+table(['Date','Test orders','Test totals (not revenue)'],days.map(([date,day])=>'<tr><td>'+e(date)+'</td><td>'+day.orders+'</td><td>'+cash(day.total)+'</td></tr>').join('')||'<tr><td colspan="3">No sales recorded.</td></tr>')+
    '<div class="section-title admin-section"><h2>Top products by units</h2></div>'+table(['Product','Test units','Test merchandise subtotal'],top.map(p=>'<tr><td>'+productLabel(findProduct(p.id)??p,e(p.name))+'</td><td>'+p.units+'</td><td>'+cash(p.total)+'</td></tr>').join('')||'<tr><td colspan="3">No products sold.</td></tr>');
}
function searchPage() {
  const rows=Object.entries(state.searches).sort((a,b)=>b[1].count-a[1].count);
  return heading('Search insights','Shared storefront searches; rate limited and excluding email-like terms.')+
    table(['Search term','Searches','No results'],rows.map(([q,n])=>'<tr><td>'+e(q)+'</td><td>'+n.count+'</td><td>'+n.misses+'</td></tr>').join('')||'<tr><td colspan="3">No searches recorded. Try the storefront search.</td></tr>');
}
function homepagePage() {
  const c=homepageSettings();
  const destinations=['/shop','/offers','/categories',...categories.map(([id])=>'/category/'+id)];
  const destination=(label,name,value)=>'<label>'+label+'<select name="'+name+'">'+destinations.map(path=>'<option value="'+e(path)+'"'+selected(path,value)+'>'+e(path==='/shop'?'All products':path==='/offers'?'Offers':path==='/categories'?'All categories':categoryName(path.split('/').at(-1)))+'</option>').join('')+'</select></label>';
  const products=state.products.filter(p=>p.status==='Published');
  return heading('Homepage','Edit the hero banner and choose the categories shown below it.',go('/','View homepage ↗','btn outline'))+
    '<form id="homepage-form" class="form-stack editor">'+
    '<section class="panel form-stack"><h2>Hero banner</h2>'+field('Small heading','eyebrow',c.eyebrow,'maxlength="100"')+
    '<label>Main heading<textarea name="title" rows="3" required maxlength="180">'+e(c.title)+'</textarea></label><label>Description<textarea name="description" rows="3" maxlength="500">'+e(c.description)+'</textarea></label><div class="field-grid">'+
    field('Main button text','primaryLabel',c.primaryLabel,'required maxlength="50"')+destination('Main button destination','primaryPath',c.primaryPath)+
    field('Second button text (leave blank to hide)','secondaryLabel',c.secondaryLabel,'maxlength="50"')+destination('Second button destination','secondaryPath',c.secondaryPath)+'</div>'+
    '<h3>Banner products</h3><p class="subtle">Choose up to three published products. Leave all three on Automatic to use homepage favourites.</p>'+[0,1,2].map(i=>'<label>Product '+(i+1)+'<select name="heroProductId"><option value="">Automatic</option>'+products.map(p=>'<option value="'+e(p.id)+'"'+selected(p.id,c.heroProductIds[i])+'>'+e(p.sku+' · '+p.name)+'</option>').join('')+'</select></label>').join('')+'</section>'+
    '<section class="panel form-stack"><h2>Homepage categories</h2>'+field('Section heading','categoryTitle',c.categoryTitle,'required maxlength="100"')+'<p class="subtle">Only checked categories appear below the banner. Uncheck all to hide this section.</p><div class="field-grid homepage-category-options">'+categories.map(([id,name])=>'<label class="check-label"><input type="checkbox" name="categoryId" value="'+e(id)+'"'+checked(c.categoryIds.includes(id))+'>'+e(name)+'</label>').join('')+'</div></section><div class="button-row"><button class="btn primary">Save homepage</button>'+go('/','View homepage','btn outline')+'</div></form>';
}
export function saveHomepage(values) {
  const text=(name)=>String(values.get(name)??'').trim();
  const limits={eyebrow:100,title:180,description:500,primaryLabel:50,secondaryLabel:50,categoryTitle:100};
  const next=Object.fromEntries(Object.entries(limits).map(([key])=>[key,text(key)]));
  if(!next.title||!next.primaryLabel||!next.categoryTitle) return 'Enter the main heading, main button text and category heading.';
  if(Object.entries(limits).some(([key,max])=>next[key].length>max)) return 'One of the text fields is too long.';
  const destinations=new Set(['/shop','/offers','/categories',...categories.map(([id])=>'/category/'+id)]);
  for(const key of ['primaryPath','secondaryPath']) {
    next[key]=text(key);
    if(!destinations.has(next[key])) return 'Choose a valid button destination.';
  }
  const ids=values.getAll('categoryId');
  if(ids.some(id=>!categories.some(([known])=>id===known))) return 'Choose a valid category.';
  next.categoryIds=[...new Set(ids)];
  next.heroProductIds=[...new Set(values.getAll('heroProductId').filter(Boolean))];
  if(next.heroProductIds.length>3||next.heroProductIds.some(id=>findProduct(id)?.status!=='Published')) return 'Choose up to three published banner products.';
  state.settings.homepage=next;save();
}
function settingsPage() {
  return heading('Settings','Delivery rules apply immediately to the storefront.')+
    '<form class="panel form-stack narrow" id="settings-form"><h2>Singapore delivery</h2>'+amountInput('Standard delivery charge (SGD)','shipping',state.settings.shipping)+
    amountInput('Free delivery threshold (SGD)','threshold',state.settings.threshold)+'<button class="btn primary">Save settings</button></form>';
}
export function adminPage(page,id,params,orderSearch='') {
  let body;
  switch(page) {
    case '': body=overview(params); break;
    case 'revenue': body=revenuePage(params);break;
    case 'products': body=id?productEditor(id,params):productList(params);break;
    case 'orders': return adminFrame(params.get('origin')==='revenue'?'revenue':'orders',id?orderEditor(id,params):ordersPage(params,orderSearch));
    case 'customers': body=customersPage();break;
    case 'coupons': body=couponPage();break;
    case 'search': body=searchPage();break;
    case 'settings': body=settingsPage();break;
    case 'homepage': body=homepagePage();break;
    default: body=empty('Admin page not found','Return to the overview.',go('/admin','Overview','btn primary'));
  }
  return adminFrame(page,body);
}
export function refreshEditorPhotos(form) {
  const p=Object.fromEntries(new FormData(form));
  for(const preview of form.querySelectorAll('[data-variant-photo]')) {
    preview.innerHTML=photo(p,'thumb',{image:preview.parentElement.querySelector('input').value});
  }
}
export function extraVariant() {
  const fields=document.querySelector('#variant-fields');
  if(fields.children.length>=15) return 'This preview supports up to 15 variants per product.';
  fields.insertAdjacentHTML('beforeend',variantFields({name:''},fields.children.length,Object.fromEntries(new FormData(fields.closest('form')))));
  fields.lastElementChild.querySelector('[name=variantName]').focus();
}
export function stockEditor(sku,variant,product) {
  return '<form class="form-stack" id="stock-editor" data-sku="'+e(sku)+'"><h2 id="dialog-title">Adjust inventory</h2>'+productLabel(product,'<b>'+e(product.name)+'</b><small>'+e(sku)+'</small>',variant)+
    field('Stock on hand','stock',variant.stock,'type="number" min="0" max="100000" required')+'<button class="btn primary">Save stock</button></form>';
}
export function couponEditor(code) {
  const c=state.coupons.find(row=>row.code===code)??{code:'',type:'percent',amount:5,min:0,active:true};
  return '<form class="form-stack" id="coupon-editor" data-code="'+e(code)+'"><h2 id="dialog-title">'+(code?'Edit coupon':'Add coupon')+'</h2>'+
    field('Code','code',c.code,'required maxlength="24" pattern="[A-Za-z0-9_&#92;x2D]+" '+(code?'readonly':''))+
    '<label>Discount type<select name="type"><option value="percent"'+selected(c.type,'percent')+'>Percentage</option><option value="fixed"'+selected(c.type,'fixed')+'>Fixed SGD amount</option><option value="shipping"'+selected(c.type,'shipping')+'>Free delivery</option></select></label>'+
    field('Discount value (% or SGD; use 0 for free delivery)','amount',c.type==='fixed'?c.amount/100:c.amount,'type="number" min="0" max="99999" step="0.01" required')+
    amountInput('Minimum subtotal (SGD)','min',c.min)+'<label class="check-label"><input type="checkbox" name="active"'+checked(c.active)+'> Active</label><button class="btn primary">Save coupon</button></form>';
}
export function storeCoupon(form,values) {
  const type=values.get('type'), code=values.get('code').toUpperCase(), number=Number(values.get('amount'));
  const current=state.coupons.find(c=>c.code===code);
  if(current&&!form.dataset.code) return 'A coupon with this code already exists.';
  if(type==='percent'&&(number<=0||number>100||!Number.isInteger(number))) return 'Enter a whole percentage from 1 to 100.';
  if(type==='fixed'&&number<=0) return 'Enter a discount greater than zero.';
  const value={code,type,amount:type==='fixed'?moneyToCents(number):type==='percent'?number:0,min:moneyToCents(values.get('min')),active:values.has('active')};
  if(current) Object.assign(current,value); else state.coupons.push(value);
  save();
}
export function storeProduct(form,values) {
  const p=findProduct(form.dataset.id), sku=values.get('sku').trim().toUpperCase();
  const image=values.get('image').trim();
  if(image&&!imageUrl(image)) return 'Enter a valid HTTPS image URL.';
  if(!sku||!values.get('name').trim()||!values.get('brand').trim()) return 'Product name, brand and parent SKU are required.';
  const variantImages=values.getAll('variantImage');
  if(variantImages.some(url=>url.trim()&&!imageUrl(url))) return 'Enter a valid HTTPS URL for each variant image.';
  const variants=values.getAll('variantName').map((name,i)=>({
    name:name.trim(),sku:values.getAll('variantSku')[i].trim().toUpperCase(),
    price:moneyToCents(values.getAll('variantPrice')[i]),stock:Number(values.getAll('variantStock')[i]),
    min:Number(values.getAll('variantMin')[i]),image:variantImages[i]?.trim()??''
  }));
  if(!variants.length) return 'Add at least one variant.';
  if(variants.some(v=>!v.name)) return 'Every variant needs a name.';
  if(variants.some(v=>!/^[A-Z0-9_-]{1,32}$/.test(v.sku)||!Number.isSafeInteger(v.price)||v.price<0||!Number.isInteger(v.stock)||v.stock<0||!Number.isInteger(v.min)||v.min<1)) return 'Enter a valid SKU, price, stock and minimum quantity for every variant.';
  if(new Set(variants.map(v=>v.sku)).size!==variants.length || state.products.some(x=>x!==p&&x.variants.some(v=>variants.some(row=>row.sku===v.sku)))) return 'Every variant needs a unique SKU.';
  if(p?.variants.some(old=>!variants.some(v=>v.sku===old.sku)&&state.adminOrders.some(o=>o.items.some(item=>item.sku===old.sku)))) return 'A variant used in an order cannot be deleted or have its SKU changed.';
  const baseName=values.get('name').trim(), oldOption=p?.variants[0]?.name;
  const name=p&&oldOption&&baseName.endsWith(' · '+oldOption)?baseName.slice(0,-(' · '+oldOption).length):baseName;
  const description=values.get('description').trim();
  const baseDescription=p&&oldOption&&description.endsWith(' · '+oldOption)?description.slice(0,-(' · '+oldOption).length):description;
  const next=variants.map((variant,index)=>{
    // A listing-level image change also replaces an unchanged variant image.
    const previousVariant=p?.variants.find(old=>old.sku===variant.sku);
    if(p&&image!==p.image&&variant.image===(previousVariant?.image??'')) variant.image=image;
    const variantImage=variant.image||image;
    return {id:variant.sku,sku:variant.sku,name:name+' · '+variant.name,brand:values.get('brand').trim(),category:values.get('category'),status:values.get('status'),
      featured:values.has('featured')&&index===0,description:baseDescription?[baseDescription,variant.name].join(' · '):variant.name,
      keywords:[values.get('keywords').trim(),variant.name].filter(Boolean).join(' '),image:variantImage,
      original:variant.image||image||p?.original||'',r2:variant.image||image||p?.r2||'',variants:[variant]};
  });
  const index=p?state.products.indexOf(p):state.products.length;
  state.products.splice(index,p?1:0,...next);
  if(p) {
    const validSkus=new Set(next.map(x=>x.sku));
    for(const old of p.variants) if(!validSkus.has(old.sku)) delete state.cart[old.sku];
    state.saved=state.saved.map(id=>id===p.id?next[0].id:id);
    state.recentlyViewed=(state.recentlyViewed??[]).map(item=>item.id===p.id?{id:next[0].id,sku:next[0].sku}:item);
  }
  save();
}
export function saveFulfilment(form,values,shipItem=false) {
  const o=state.adminOrders.find(o=>o.id===form.dataset.order);
  if(!o) return 'Order not found.';
  if(shipItem&&o.status!=='Processing') return 'Only orders awaiting shipment can be shipped.';
  return updateOrder(o,shipItem?'Shipped':values.get('status'),values.get('tracking').trim());
}
export function saveSettings(values) {
  state.settings.shipping=moneyToCents(values.get('shipping'));
  state.settings.threshold=moneyToCents(values.get('threshold'));
  save();
}
const columns=['sku','name','brand','category','status','featured','description','keywords','image','original','r2','variant_sku','variant_name','price','stock','min','variant_image'];
const exportRows = products => products.flatMap(p=>p.variants.map(v=>[p.sku,p.name,p.brand,p.category,p.status,p.featured,p.description,p.keywords,p.image,p.original,p.r2,v.sku,v.name,(v.price/100).toFixed(2),v.stock,v.min,v.image??'']));
const csvValue=value=>{
  let cell=String(value??'');
  if(/^[=+@\t\r-]/.test(cell)) cell="'"+cell;
  return '"'+cell.replaceAll('"','""')+'"';
};
function download(name,rows) {
  const url=URL.createObjectURL(new Blob(['\ufeff'+rows.map(r=>r.map(csvValue).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function exportRevenueReport(params) {
  const {period,orders}=revenueSelection(params);
  const amount=value=>(value/100).toFixed(2);
  const header=['order_id','order_date','status','units','merchandise_sgd','delivery_sgd','discount_sgd','order_total_sgd','revenue_sgd'];
  const rows=orders.map(o=>[o.id,o.date,o.status,o.items.reduce((units,item)=>units+item.qty,0),
    amount(o.totals.subtotal),amount(o.totals.shipping),amount(o.totals.discount),amount(o.totals.total),amount(orderRevenue(o))]);
  download('cp-value-mart-revenue-'+period.from+'_to_'+period.to+'.csv',[header,...rows]);
}
export function exportData(kind,products=state.products) {
  if(kind==='template') return download('cp-value-mart-import-template.csv',[columns,['CP-900','Sample body wash','Sample Brand','personal-care','Draft',false,'Demo product','body wash','','','', 'CP-900-01','Standard','6.90',20,1,'']]);
  if(kind==='orders') return download('cp-value-mart-orders.csv',[['order','date','name','status','tracking','total_sgd'],...state.adminOrders.map(o=>[o.id,o.date,o.name,o.status,o.tracking,(o.totals.total/100).toFixed(2)])]);
  download('cp-value-mart-products.csv',[columns,...exportRows(products)]);
}
export function parseCsv(text) {
  const rows=[]; let row=[], cell='', quoted=false, afterQuote=false;
  const source=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quoted) {
      if(c==='"'&&source[i+1]==='"') { cell+='"'; i++; }
      else if(c==='"') { quoted=false; afterQuote=true; }
      else cell+=c;
    } else if(c===','||c==='\n') {
      row.push(cell); cell=''; afterQuote=false;
      if(c==='\n') { if(row.some(Boolean)) rows.push(row); row=[]; }
    } else if(c==='"'&&!cell&&!afterQuote) quoted=true;
    else if(afterQuote||c==='"') throw Error('Unexpected text after a quote. Check the CSV formatting.');
    else cell+=c;
  }
  if(quoted) throw Error('A quoted CSV cell was left open.');
  row.push(cell); if(row.some(Boolean)) rows.push(row);
  return rows;
}
export function prepareProductImport(text) {
  const [header,...rows]=parseCsv(text);
  if(!header||!rows.length) throw Error('The CSV contains no products.');
  const required=['sku','name','brand','category','variant_sku','variant_name','price','stock','min'];
  if(required.some(col=>!header.includes(col))||new Set(header).size!==header.length) throw Error('Use the CSV template so the required columns are present.');
  const next=structuredClone(state.products), touched=new Set(), seenVariants=new Set();
  for(const [i,row] of rows.entries()) {
    const input=Object.fromEntries(header.map((key,j)=>[key,(row[j]??'').trim()]));
    const sku=input.sku.toUpperCase(), variantSku=input.variant_sku.toUpperCase();
    const price=Number(input.price), units=Number(input.stock), min=Number(input.min);
    if(row.length!==header.length||required.some(col=>!input[col])||
      ![sku,variantSku].every(s=>/^[A-Z0-9_-]{1,32}$/.test(s))||
      !categories.some(([id])=>id===input.category)||
      !Number.isFinite(price)||price<0||price>99999||
      !Number.isInteger(units)||units<0||units>100000||
      !Number.isInteger(min)||min<1||min>100000||
      (input.image&&!imageUrl(input.image))||
      (input.variant_image&&!imageUrl(input.variant_image))||
      (input.status&&!['Draft','Published','Archived'].includes(input.status))) throw Error('Check values in CSV row '+(i+2)+'. No changes were applied.');
    if(seenVariants.has(variantSku)) throw Error('Duplicate variant SKU in row '+(i+2)+'.');
    seenVariants.add(variantSku);
    let p=next.find(p=>p.variants.some(v=>v.sku===variantSku));
    const variant={sku:variantSku,name:input.variant_name,price:moneyToCents(price),stock:units,min};
    if('variant_image' in input) variant.image=input.variant_image;
    const withOption=value=>value.endsWith(' · '+variant.name)?value:value+' · '+variant.name;
    const product={id:variantSku,sku:variantSku,name:withOption(input.name),brand:input.brand,category:input.category,
      status:input.status||p?.status||'Draft',featured:'featured' in input?input.featured.toLowerCase()==='true':p?.featured??false,
      description:input.description?withOption(input.description):variant.name,
      keywords:[input.keywords,variant.name].filter(Boolean).join(' '),
      image:variant.image||input.image||p?.image||'',original:variant.image||input.original||p?.original||'',
      r2:variant.image||input.r2||p?.r2||'',variants:[variant]};
    if(p) Object.assign(p,product); else next.push(product);
    touched.add(variantSku);
  }
  return next.filter(product=>touched.has(product.sku));
}
export function bulkUpdate(values) {
  const ids=values.getAll('id'), action=values.get('action'), rows=state.products.filter(p=>ids.includes(p.id));
  if(!rows.length) return 'Select at least one product.';
  if(action==='Export selected') {exportData('products',rows);return 'CSV exported.';}
  const status={'Publish':'Published','Move to draft':'Draft','Archive':'Archived'}[action];
  for(const p of rows) {
    if(status) p.status=status; else p.featured=action==='Feature on homepage';
  }
  save(); return rows.length+' products updated.';
}

export function importProducts(text) {
 const products=prepareProductImport(text);
 for(const product of products){const old=state.products.find(p=>p.sku===product.sku);if(old)Object.assign(old,product);else state.products.push(product);}
 save();return products.length;
}
