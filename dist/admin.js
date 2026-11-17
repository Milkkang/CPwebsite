import {state,save,cash,escape as e,categoryName,categories,statusList,updateOrder,imageUrl,findProduct,orderDate} from './store.js';
import {go,link,href,badge,selected,checked,photo,empty,orderDisplay,productLabel,orderItemsPreview} from './shop.js';
import {overviewAnalytics,revenueMetric,revenueAnalytics} from './analytics.js';

const nav=[['','Overview'],['revenue','Revenue'],['products','Products'],['customers','Customers'],['coupons','Coupons'],['search','Search insights'],['settings','Settings']];
export function adminFrame(page,body) {
  return '<header class="admin-top"><div class="wrap"><a class="logo" href="#/admin"><span class="mark">CP</span><span>CP Value Mart <b>Admin</b></span></a><div class="button-row"><span class="badge status-draft">Design preview</span>'+go('/','View storefront ↗','btn outline small')+'</div></div></header>'+
    '<div class="wrap admin-layout"><aside class="admin-nav"><nav aria-label="Admin">'+nav.map(([k,n])=>go('/admin'+(k?'/'+k:''),n,k===page?'active':'')).join('')+'</nav></aside><main class="admin-main" id="main">'+body+'</main></div>';
}
const heading=(title,subtitle='',actions='')=>'<div class="admin-heading"><div><h1>'+title+'</h1>'+(subtitle?'<p>'+subtitle+'</p>':'')+'</div><div class="button-row">'+actions+'</div></div>';
const table=(headers,rows)=>'<div class="panel table-wrap"><table><thead><tr>'+headers.map(h=>'<th scope="col">'+h+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
const field=(label,name,value,options='')=>'<label>'+label+'<input name="'+name+'" value="'+e(value)+'" '+options+'></label>';
const amountInput=(label,name,cents)=>field(label,name,(cents/100).toFixed(2),'type="number" min="0" max="99999" step="0.01" required');
const moneyToCents=value=>Math.round(Number(value)*100);
const opts=(values,value)=>values.map(v=>'<option'+selected(v,value)+'>'+e(v)+'</option>').join('');
const cats=value=>categories.map(([id,name])=>'<option value="'+id+'"'+selected(id,value)+'>'+e(name)+'</option>').join('');
const editHref=p=>href('/admin/products/'+p.id);

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
  const orders=state.orders.filter(o=>o.date>=period.from&&o.date<=period.to).sort((a,b)=>b.date.localeCompare(a.date));
  return {range,period,orders,dateError};
}
const orderRevenue=order=>order.status==='Cancelled'?0:order.totals.total;
function revenuePage(params) {
  const today=orderDate();
  const {range,period,orders,dateError}=revenueSelection(params,today);
  const metric=revenueMetric(params.get('metric'));
  const filters={range,...(range==='custom'?period:{})};
  const orderLinks={origin:'revenue',...filters,metric:metric.key};
  return heading('Revenue','Review order history and export a CSV for the selected dates.',
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
    '<p class="subtle revenue-note">Based on simulated orders. Revenue includes delivery fees and subtracts discounts. Cancelled orders are excluded from revenue.</p>'+
    '<div class="section-title admin-section"><h2>Order History <small class="subtle">('+orders.length+')</small></h2><span class="subtle">'+e(period.from)+(period.from===period.to?'':' to '+e(period.to))+'</span></div>'+
    ordersTable(orders,orderLinks);
}
function overview(params) {
  const range=periods.some(([key])=>key===params.get('range'))?params.get('range'):'1m';
  const q=params.get('q')??'', status=params.get('status')??'';
  const metric=params.get('metric')??'sales';
  const filters={range,metric,...(q?{q}:{}),...(status?{status}:{})};
  const {from,to}=orderPeriod(range);
  const periodOrders=state.orders.filter(o=>o.date>=from&&o.date<=to);
  const orders=periodOrders.filter(o=>
    (o.id+' '+o.name+' '+o.email).toLowerCase().includes(q.toLowerCase())&&(!status||o.status===status)
  ).sort((a,b)=>b.date.localeCompare(a.date));
  const valid=periodOrders.filter(o=>o.status!=='Cancelled');
  return heading('Overview','Store performance · Singapore time',go('/admin/products/new','Add product','btn primary'))+
    '<div class="period-control"><nav class="period-options" aria-label="Order date range">'+periods.map(([key,label])=>
      '<a class="btn small '+(key===range?'chosen':'outline')+'" href="'+e(href('/admin',{...filters,range:key}))+'"'+(key===range?' aria-current="true"':'')+'>'+label+'</a>'
    ).join('')+'</nav><p class="subtle">'+(from===to?to:from+' to '+to)+'</p></div>'+
    overviewAnalytics({from,to},filters,valid,metric)+
    '<div class="section-title admin-section"><h2>Orders <small class="subtle">('+orders.length+')</small></h2><button class="btn outline small" data-export="orders">Export all orders</button></div>'+
    '<form class="admin-filters" id="admin-filter" data-path="/admin"><input type="hidden" name="range" value="'+e(range)+'"><input type="hidden" name="metric" value="'+e(metric)+'">'+
    field('Find order','q',q,'placeholder="Order number or customer"')+
    '<label>Status<select name="status"><option value="">All statuses</option>'+opts(statusList,status)+'</select></label><button class="btn outline">Filter</button></form>'+
    ordersTable(orders,filters)+salesTables(valid)+
    '<div class="section-title admin-section"><h2>Quick actions</h2></div><div class="quick-grid">'+go('/admin/products','Manage products and images ↗','panel')+link(href('/admin/products',{low:'1'}),'Review low stock ↗','panel')+go('/admin/search','Inspect search terms ↗','panel')+'</div>';
}
const productSearch = (q='',mode='') => state.products.filter(p=>{
  const text=[p.name,p.brand,p.sku,categoryName(p.category),...p.variants.map(v=>v.sku)].join(' ').toLowerCase();
  return text.includes(q.toLowerCase())&&(!mode||p.status===mode);
});
function productList(params) {
  const q=params.get('q')??'', status=params.get('status')??'', low=params.get('low')==='1';
  const rows=productSearch(q,status).map(p=>({p,variants:low?p.variants.filter(v=>v.stock<=5):p.variants}))
    .filter(row=>row.variants.length);
  return heading('Products',rows.length+' of '+state.products.length+' products',
    '<label class="btn outline import-label">Import CSV<input id="import-csv" type="file" accept=".csv,text/csv" class="sr-only"></label><button class="btn outline" data-export="products">Export CSV</button>'+go('/admin/products/new','Add product','btn primary'))+
    '<p class="subtle import-hint"><button class="link-button" data-export="template">Download CSV template</button> · Import updates by product and variant SKU.</p>'+
    '<form class="admin-filters" id="admin-filter" data-path="/admin/products">'+field('Find product','q',q,'placeholder="Name, brand or SKU"')+
    '<label>Status<select name="status"><option value="">All statuses</option>'+opts(['Published','Draft','Archived'],status)+'</select></label>'+
    '<label>Availability<select name="low"><option value="">All stock levels</option><option value="1"'+selected(low,true)+'>Low stock (5 or fewer)</option></select></label><button class="btn outline">Filter</button></form>'+
    (!rows.length?empty('No matching products','Adjust or clear the product filters.'):
    '<form id="bulk-form"><div class="bulk-tools"><label class="check-label"><input type="checkbox" id="select-all"> Select all shown</label><label class="sr-only" for="bulk-action">Bulk action</label><select id="bulk-action" name="action" required><option value="">Bulk action</option><option>Publish</option><option>Move to draft</option><option>Archive</option><option>Feature on homepage</option><option>Remove from homepage</option><option>Export selected</option></select><button class="btn small primary">Apply</button></div>'+
    table(['<span class="sr-only">Select product</span>','Product','Variant','Price (SGD)','Stock','MOQ','Status',''],rows.map(productRows).join(''))+'</form>');
}
function productRows({p,variants}) {
  const span=' rowspan="'+variants.length+'"';
  const product=productLabel(p,'<b>'+e(p.name)+'</b><small>'+e(p.brand)+' · '+e(p.sku)+'</small>'+
    (p.original?'<small>Original: '+e(p.original)+'</small>':''));
  return variants.map((v,i)=>'<tr class="'+(i===0?'product-row-start':'')+'">'+
    (i===0?'<td'+span+'><input type="checkbox" name="id" value="'+e(p.id)+'" aria-label="Select '+e(p.name)+'"></td><td'+span+'>'+product+'</td>':'')+
    '<td><div class="admin-variant">'+photo(p,'variant-thumb',v)+'<div><b>'+e(v.name)+'</b><small>'+e(v.sku)+'</small></div></div></td>'+
    '<td class="variant-number">'+cash(v.price)+'</td><td class="variant-stock"><span>'+v.stock+'</span><button type="button" class="btn outline small" data-stock="'+e(v.sku)+'" aria-label="Adjust stock for '+e(v.sku)+'">Adjust</button></td><td>'+v.min+'</td>'+
    (i===0?'<td'+span+'>'+badge(p.status)+'</td><td'+span+'>'+link(editHref(p),'Edit ↗','text-link')+'</td>':'')+'</tr>').join('');
}
function variantFields(v={},i=0,p={}) {
  return '<fieldset class="variant-fields"><legend>Variant '+(i+1)+'</legend><input type="hidden" name="oldSku" value="'+e(v.sku??'')+'">'+
    field('Name','variantName',v.name??'Standard','required maxlength="60"')+
    field('Variant SKU','variantSku',v.sku??'','required maxlength="32" pattern="[A-Za-z0-9_&#92;x2D]+"')+
    amountInput('Price (SGD)','variantPrice',v.price??0)+
    field('Stock','variantStock',v.stock??0,'type="number" min="0" max="100000" step="1" required')+
    field('Minimum qty','variantMin',v.min??1,'type="number" min="1" max="100000" step="1" required')+
    '<div class="variant-image-field"><span data-variant-photo>'+photo(p,'thumb',v)+'</span>'+
    field('Variant image URL','variantImage',v.image??'','maxlength="350" placeholder="https://…"')+'</div></fieldset>';
}
export function productEditor(id) {
  const existing=findProduct(id);
  if(id!=='new'&&!existing) return empty('Product not found','Return to the product list.',go('/admin/products','View products','btn primary'));
  const p=existing??{sku:'',name:'',brand:'',category:'others',status:'Draft',description:'',keywords:'',image:'',original:'',r2:'',variants:[{}]};
  return go('/admin/products','← Products','text-link')+heading(existing?'Edit product':'Add product',existing?e(p.sku):'Enter details and at least one variant.')+
    '<form id="product-editor" data-id="'+e(existing?.id??'')+'" class="form-stack editor"><section class="panel form-stack"><h2>Product information</h2>'+(existing?productLabel(p,'<b>'+e(p.name)+'</b>'):'')+'<div class="field-grid">'+
    field('Product name','name',p.name,'required maxlength="120"')+field('Brand','brand',p.brand,'required maxlength="70"')+
    field('Parent SKU','sku',p.sku,'required maxlength="32" pattern="[A-Za-z0-9_&#92;x2D]+" '+(existing?'readonly':''))+
    '<label>Category<select name="category">'+cats(p.category)+'</select></label><label>Status<select name="status">'+opts(['Draft','Published','Archived'],p.status)+'</select></label>'+
    '<label class="check-label featured-field"><input type="checkbox" name="featured"'+checked(p.featured)+'> Feature on homepage</label></div>'+
    '<label>Description<textarea name="description" rows="3" maxlength="1000">'+e(p.description)+'</textarea></label>'+
    field('Search keywords','keywords',p.keywords,'maxlength="300" placeholder="English names, 中文 keywords, common abbreviations"')+'</section>'+
    '<section class="panel form-stack"><div class="section-title"><h2>Variants, stock and price</h2><button type="button" class="btn outline small" data-add-variant>Add variant</button></div><div id="variant-fields">'+p.variants.map((v,i)=>variantFields(v,i,p)).join('')+'</div></section>'+
    '<section class="panel form-stack"><h2>Image references</h2><div class="image-references">'+editorPhotos(p)+'</div>'+
    field('Storefront image URL','image',p.image,'maxlength="350" placeholder="https://…"')+
    field('Original image reference','original',p.original,'maxlength="300"')+field('R2 object key or reference URL','r2',p.r2,'maxlength="300"')+'</section>'+
    '<div class="button-row"><button class="btn primary">Save product</button>'+go('/admin/products','Cancel','btn outline')+'</div></form>';
}
function ordersTable(rows,filters) {
  return table(['Order','Customer','Products','Date','Status','Total',''],rows.map(o=>'<tr><td><b>'+e(o.id)+'</b></td><td>'+e(o.name)+'</td><td>'+orderItemsPreview(o.items)+'</td><td>'+e(o.date)+'</td><td>'+badge(o.status)+'</td><td>'+cash(o.totals.total)+'</td><td>'+link(href('/admin/orders/'+o.id,filters),'Open ↗','text-link')+'</td></tr>').join('')||'<tr><td colspan="7">No matching orders for this period.</td></tr>');
}
function orderEditor(id,params) {
  const o=state.orders.find(o=>o.id===id);
  const {origin,...filters}=Object.fromEntries(params);
  const back=href(origin==='revenue'?'/admin/revenue':'/admin',filters);
  if(!o) return empty('Order not found','Return to the order list.',link(back,'View orders','btn primary'));
  return link(back,origin==='revenue'?'← Revenue order history':'← Overview orders','text-link')+heading(e(o.id),'Simulated payment · '+e(o.date))+'<div class="two-col">'+orderDisplay(o)+
    '<div class="form-stack"><section class="panel"><h2>Delivery address</h2><p>'+e(o.name)+'<br>'+e(o.address)+'<br>Singapore '+e(o.postal)+'</p><p>'+e(o.email)+'</p></section>'+
    '<form class="panel form-stack" id="order-editor" data-order="'+e(id)+'"><h2>Fulfilment</h2><label>Status<select name="status" '+(o.status==='Cancelled'?'disabled':'')+'>'+opts(statusList,o.status)+'</select></label>'+
    field('Courier tracking number','tracking',o.tracking,'maxlength="50" '+(o.status==='Cancelled'?'readonly':''))+
    '<div class="button-row">'+(o.status==='Processing'?'<button type="submit" class="btn primary" name="ship-item">Ship Item</button>':'')+
    '<button type="submit" class="btn '+(o.status==='Processing'?'outline':'primary')+'" '+(o.status==='Cancelled'?'disabled':'')+'>Save fulfilment</button></div></form></div></div>';
}
function couponPage() {
  return heading('Coupons','Create and manage codes for the storefront.','<button class="btn primary" data-edit-coupon="">Add coupon</button>')+
    table(['Code','Type','Value','Min. subtotal','Status',''],state.coupons.map(c=>'<tr><td><b>'+e(c.code)+'</b></td><td>'+e(c.type==='shipping'?'Free delivery':c.type==='fixed'?'Fixed discount':'Percentage')+'</td><td>'+(c.type==='shipping'?'—':c.type==='fixed'?cash(c.amount):c.amount+'%')+'</td><td>'+cash(c.min)+'</td><td>'+badge(c.active?'Active':'Inactive')+'</td><td><button class="btn small outline" data-edit-coupon="'+e(c.code)+'">Edit</button></td></tr>').join('')||'<tr><td colspan="6">No coupons created.</td></tr>');
}
function customersPage() {
  const customers=new Map();
  for(const o of state.orders) {
    const c=customers.get(o.email)??{name:o.name,email:o.email,orders:0,spend:0};
    c.orders++;
    if(o.status!=='Cancelled') c.spend+=o.totals.total;
    customers.set(o.email,c);
  }
  return heading('Customers',customers.size+' sample shopper profiles from demo orders.')+
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
  return '<div class="section-title admin-section"><h2>Daily sales</h2></div>'+table(['Date','Orders','Sales'],days.map(([date,day])=>'<tr><td>'+e(date)+'</td><td>'+day.orders+'</td><td>'+cash(day.total)+'</td></tr>').join('')||'<tr><td colspan="3">No sales recorded.</td></tr>')+
    '<div class="section-title admin-section"><h2>Top products by units</h2></div>'+table(['Product','Units','Merchandise subtotal'],top.map(p=>'<tr><td>'+productLabel(findProduct(p.id)??p,e(p.name))+'</td><td>'+p.units+'</td><td>'+cash(p.total)+'</td></tr>').join('')||'<tr><td colspan="3">No products sold.</td></tr>');
}
function searchPage() {
  const rows=Object.entries(state.searches).sort((a,b)=>b[1].count-a[1].count);
  return heading('Search insights','Searches submitted in this preview browser.')+
    table(['Search term','Searches','No results'],rows.map(([q,n])=>'<tr><td>'+e(q)+'</td><td>'+n.count+'</td><td>'+n.misses+'</td></tr>').join('')||'<tr><td colspan="3">No searches recorded. Try the storefront search.</td></tr>');
}
function settingsPage() {
  return heading('Settings','Delivery rules apply immediately to the storefront.')+
    '<form class="panel form-stack narrow" id="settings-form"><h2>Singapore delivery</h2>'+amountInput('Standard delivery charge (SGD)','shipping',state.settings.shipping)+
    amountInput('Free delivery threshold (SGD)','threshold',state.settings.threshold)+'<button class="btn primary">Save settings</button></form>'+
    '<section class="panel narrow reset-panel"><h2>Reset demo data</h2><p>Restore the sample products, stock, coupons and orders for this browser.</p><button class="btn outline" data-reset>Reset preview</button></section>';
}
export function adminPage(page,id,params) {
  let body;
  switch(page) {
    case '': body=overview(params); break;
    case 'revenue': body=revenuePage(params);break;
    case 'products': body=id?productEditor(id):productList(params);break;
    case 'orders': return adminFrame(params.get('origin')==='revenue'?'revenue':'',orderEditor(id,params));
    case 'customers': body=customersPage();break;
    case 'coupons': body=couponPage();break;
    case 'search': body=searchPage();break;
    case 'settings': body=settingsPage();break;
    default: body=empty('Admin page not found','Return to the overview.',go('/admin','Overview','btn primary'));
  }
  return adminFrame(page,body);
}
function editorPhotos(p) {
  return '<div>'+photo(p,'editor-photo')+'<small>Product image</small></div>'+
    (imageUrl(p.original)?'<div>'+photo(p,'editor-photo',undefined,p.original)+'<small>Original image</small></div>':'');
}
export function refreshEditorPhotos(form) {
  const p=Object.fromEntries(new FormData(form));
  form.querySelector('.image-references').innerHTML=editorPhotos(p);
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
    field('Available units','stock',variant.stock,'type="number" min="0" max="100000" required')+'<button class="btn primary">Save stock</button></form>';
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
  if(!values.get('name').trim()||!values.get('brand').trim()) return 'Product name and brand are required.';
  if(state.products.some(x=>x!==p&&x.sku===sku)) return 'That parent SKU already exists.';
  const variantImages=values.getAll('variantImage');
  if(variantImages.some(url=>url.trim()&&!imageUrl(url))) return 'Enter a valid HTTPS URL for each variant image.';
  const variants=values.getAll('variantName').map((name,i)=>({
    name:name.trim(),sku:values.getAll('variantSku')[i].trim().toUpperCase(),
    price:moneyToCents(values.getAll('variantPrice')[i]),stock:Number(values.getAll('variantStock')[i]),
    min:Number(values.getAll('variantMin')[i]),image:variantImages[i]?.trim()??''
  }));
  if(variants.some(v=>!v.name)) return 'Every variant needs a name.';
  if(new Set(variants.map(v=>v.sku)).size!==variants.length || state.products.some(x=>x!==p&&x.variants.some(v=>variants.some(row=>row.sku===v.sku)))) return 'Every variant needs a unique SKU.';
  const oldSkus=values.getAll('oldSku');
  if(variants.some((v,i)=>oldSkus[i]&&oldSkus[i]!==v.sku&&state.orders.some(o=>o.items.some(item=>item.sku===oldSkus[i])))) return 'A variant SKU used in an order must stay the same.';
  const valuesToStore={id:p?.id??sku,sku,name:values.get('name').trim(),brand:values.get('brand').trim(),category:values.get('category'),status:values.get('status'),
    featured:values.has('featured'),description:values.get('description').trim(),keywords:values.get('keywords').trim(),image,original:values.get('original').trim(),r2:values.get('r2').trim(),variants};
  if(p) Object.assign(p,valuesToStore); else state.products.push(valuesToStore);
  save();
}
export function saveFulfilment(form,values,shipItem=false) {
  const o=state.orders.find(o=>o.id===form.dataset.order);
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
  if(kind==='orders') return download('cp-value-mart-orders.csv',[['order','date','name','status','tracking','total_sgd'],...state.orders.map(o=>[o.id,o.date,o.name,o.status,o.tracking,(o.totals.total/100).toFixed(2)])]);
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
export function importProducts(text) {
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
    if(seenVariants.has(variantSku)||next.some(p=>p.sku!==sku&&p.variants.some(v=>v.sku===variantSku))) throw Error('Duplicate variant SKU in row '+(i+2)+'.');
    seenVariants.add(variantSku);
    let p=next.find(p=>p.sku===sku);
    if(!p){p={id:sku,sku,variants:[],status:'Draft',featured:false};next.push(p);}
    Object.assign(p,{name:input.name,brand:input.brand,category:input.category});
    for(const key of ['status','description','keywords','image','original','r2']) if(key in input&&(key!=='status'||input[key])) p[key]=input[key];
    if('featured' in input) p.featured=input.featured.toLowerCase()==='true';
    const variant={sku:variantSku,name:input.variant_name,price:moneyToCents(price),stock:units,min};
    if('variant_image' in input) variant.image=input.variant_image;
    const v=p.variants.find(v=>v.sku===variantSku);
    if(v) Object.assign(v,variant); else p.variants.push(variant);
    touched.add(sku);
  }
  state.products=next; save(); return touched.size;
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
