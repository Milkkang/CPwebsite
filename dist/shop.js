import {state,cash,escape as e,categories,categoryName,productPrice,cartLines,totals,matching,imageUrl,statusList,findProduct,buyerOrders,pendingReviewItems,homepageSettings} from './store.js';

export const href = (path, params={}) => '#'+path+(Object.keys(params).length ? '?'+new URLSearchParams(params) : '');
export const link = (path,label,klass='') => '<a class="'+klass+'" href="'+e(path)+'">'+label+'</a>';
export const go = (path,label,klass='') => link(href(path),label,klass);
export const badge = (status,label=status) => '<span class="badge status-'+status.toLowerCase().replaceAll(' ','-')+'">'+e(label)+'</span>';
export const empty = (title,copy,action='') => '<section class="empty"><h2>'+title+'</h2><p>'+copy+'</p>'+action+'</section>';
export const selected = (a,b) => a===b?' selected':'';
export const checked = condition => condition?' checked':'';
export const crumb = (...labels) => '<div class="crumb">'+go('/','Home')+labels.map(label=>' <span aria-hidden="true">/</span> '+label).join('')+'</div>';
export const icon = name => {
  const paths={
    search:'<circle cx="10.7" cy="10.7" r="6.5"/><path d="m16 16 4 4"/>',
    bag:'<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',
    user:'<circle cx="12" cy="7.5" r="3.5"/><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2"/>',
    heart:'<path d="M20.8 8.4c0 4.1-8.8 10.6-8.8 10.6S3.2 12.5 3.2 8.4A4.6 4.6 0 0 1 12 6.5a4.6 4.6 0 0 1 8.8 1.9Z"/>',
    box:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8m-8 5h8"/>',
    truck:'<path d="M3 5h11v12H3zM14 9h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z"/>',
    delivered:'<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.4 2.5 4.7-5"/>',
    coupon:'<path d="M3 6h18v4a2 2 0 1 0 0 4v4H3v-4a2 2 0 1 0 0-4V6Zm11 1.5v1m0 3v1m0 3v1"/>'
  };
  return '<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+(paths[name]??paths.box)+'</svg>';
};
function imagePlaceholder(p) {
  const category=categories.find(c=>c[0]===p.category)??categories.at(-1);
  return '<span class="photo-fallback '+category[3]+'" title="Image unavailable" aria-hidden="true"><span class="pack"><span>'+category[2]+'</span><b>'+e(p.brand)+'</b></span></span>';
}
export function photo(p, style='', variant, reference) {
  const sources=[...new Set((reference===undefined?[variant?.image,p.r2,p.image]:[reference]).map(imageUrl).filter(Boolean))];
  const label=p.name||'Product image';
  const classes='photo '+style;
  const card=style==='card-photo';
  const destination=href('/product/'+p.id);
  if(!sources.length) return card?'<a class="'+classes+'" href="'+e(destination)+'" aria-label="View '+e(label)+'">'+imagePlaceholder(p)+'</a>':'<span class="'+classes+'">'+imagePlaceholder(p)+'</span>';
  const [src,...fallbacks]=sources;
  const opener=card?'<a class="'+classes+'" href="'+e(destination)+'" aria-label="View '+e(label)+'">':'<button type="button" class="'+classes+'" data-image-preview="'+e(label)+'" aria-label="Enlarge image of '+e(label)+'">';
  return opener+
    '<img src="'+e(src)+'" alt="" data-image-fallbacks="'+e(JSON.stringify(fallbacks))+'" '+(style==='detail-photo'?'fetchpriority="high"':'loading="lazy"')+'>'+
    '<span class="photo-error" hidden>'+imagePlaceholder(p)+'</span>'+(card?'</a>':'</button>');
}
export function productLabel(p, content, variant) {
  return '<span class="table-product">'+photo(p,'thumb',variant)+'<span class="product-label">'+content+'</span></span>';
}
export function orderItemLabel(item,showRating=false) {
  const p=findProduct(item.productId)??{name:item.name};
  const v=p.variants?.find(v=>v.sku===item.sku);
  return productLabel(p,'<b>'+e(item.name)+'</b><small>'+e(item.option)+' × '+item.qty+'</small>'+(showRating&&item.review?'<small>Rated '+e(item.review.rating)+'/5</small>':''),v);
}
export const orderItemsPreview = (items,{showRating=false}={}) => '<ul class="item-previews">'+items.map(item=>'<li>'+orderItemLabel(item,showRating)+'</li>').join('')+'</ul>';
const logo=()=>go('/','<span class="mark" aria-hidden="true"></span><span>CP <b>Value Mart</b></span>','logo');
export function shopFrame(body, query='') {
  const items=Object.values(state.cart).reduce((a,b)=>a+b,0);
  return '<div class="topline"><span>DESIGN PREVIEW</span><span>Singapore delivery · Free from '+cash(state.settings.threshold)+'</span></div>'+
    '<header class="shop-head"><div class="wrap head-inner">'+logo()+
    '<form class="search" id="search-form">'+icon('search')+'<input name="q" aria-label="Search products" type="search" placeholder="Search products, brands or SKU" value="'+e(query)+'" maxlength="100"><button>Search</button></form>'+
    '<nav class="top-actions" aria-label="Account and shopping"><a class="header-saved" href="#/saved" title="Saved Items" aria-label="Saved Items">'+icon('heart')+'<span aria-hidden="true">Saved Items</span></a><a href="#/account" title="My account" aria-label="My account">'+icon('user')+'</a><a class="bag-link" href="#/cart" aria-label="Basket, '+items+' items">'+icon('bag')+'<span>Basket</span><b>'+items+'</b></a></nav></div>'+
    '<nav class="category-nav wrap" aria-label="Main categories">'+go('/shop','Shop all')+categories.map(([id,name])=>go('/category/'+id,e(name))).join('')+'</nav></header>'+
    '<main id="main" class="wrap main">'+body+'</main>'+
    '<footer><div class="wrap footer-inner"><section>'+logo()+'<p>Everyday essentials for Singapore homes.</p></section><section><h3>Shop</h3>'+go('/shop','All products')+go('/offers','Offers')+'</section><section><h3>Customer care</h3>'+go('/delivery','Delivery & returns')+go('/faq','FAQs')+go('/contact','Contact')+'</section><section><h3>CP Value Mart</h3>'+go('/about','About us')+go('/privacy','Privacy')+go('/terms','Terms')+go('/admin','Admin preview')+'</section></div><div class="wrap footer-bottom">CP Value Mart · Singapore · SGD</div></footer>';
}
const categoryIcon = id => {
  const paths = {
    'personal-care':'<path d="M9 7h6v3H9zM10 4h7m-5 0v3M8 10h8l1 10H7l1-10Z"/><path d="M10 14h4"/>',
    'hair-care':'<path d="M5 4h5v3H5zM4 7h7v13H4zM6 12h3M15 4v16m0-14h5m-5 3h5m-5 3h5m-5 3h5m-5 3h5"/>',
    'oral-care':'<path d="M5 4h4v6H5zM5 6h4M5 8h4M7 10v10M14 4h5l1 16h-7l1-16ZM14 8h5m-5 8h5"/>',
    'skin-care':'<path d="M5 11h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8ZM4 8h16v3H4zM12 2c0 0-2 2-2 3a2 2 0 0 0 4 0c0-1-2-3-2-3ZM9 15h6"/>',
    'home-cleaning':'<path d="M9 3h9v3h-5v3H8V6h1V3ZM13 6l4 3M8 9h5l3 11H5L8 9ZM8 15h5"/>',
    'laundry':'<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M8 13c2-3 6 3 8 0M7 6h1m3 0h6"/>',
    'paper-tissues':'<path d="M4 11h16v9H4zM4 14h16M9 11 7 5l5-2 4 3-2 5M9 11h6"/>',
    'baby-family':'<path d="m8 3 5 2-1 3-5-2 1-3ZM7 6l5 2 4 9a3 3 0 0 1-4 4l-8-4a3 3 0 0 1-1-4l4-7ZM7 11l3 2m-5 1 3 2"/>',
    'food-pantry':'<path d="M7 4h10v3l2 3v11H5V10l2-3V4ZM7 7h10M5 11h14M12 13v6m0-3-3-2m3 4 3-2"/>',
    'snacks-drinks':'<path d="M14 8h7l-1 13h-5L14 8ZM17 8l1-5h3M3 5h8l-1 3 1 10H3L4 8 3 5ZM4 9h6M4 15h6"/>',
    'others':'<path d="m3 8 9-5 9 5-9 5-9-5ZM3 8v9l9 5 9-5V8M12 13v9M7 6l10 5"/>'
  };
  return '<svg class="category-symbol" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+paths[id]+'</svg>';
};
const categoriesGrid = (rows=categories) => '<div class="cat-grid">'+rows.map(([id,name,symbol,tone])=>go('/category/'+id,'<span class="cat-icon '+tone+'">'+categoryIcon(id)+'</span><b>'+e(name)+'</b>','cat-card')).join('')+'</div>';
export function card(p,{quickAdd=false}={}) {
  const saved=state.saved.includes(p.id), variant=p.variants.find(v=>v.stock>=v.min), single=p.variants.length===1;
  const direct=quickAdd&&variant;
  const add=direct?'<button type="button" class="add-btn" data-quick-add="'+e(variant.sku)+'" aria-label="Add '+e(p.name)+' ('+e(variant.name)+') to basket">+</button>':
    go('/product/'+p.id,'<span aria-hidden="true">+</span><span class="sr-only">Choose options for '+e(p.name)+'</span>','add-btn');
  return '<article class="product-card">'+photo(p,'card-photo')+
    '<button class="save-btn '+(saved?'saved':'')+'" data-save="'+e(p.id)+'" aria-pressed="'+saved+'" aria-label="Save '+e(p.name)+'">'+icon('heart')+'</button>'+
    '<div class="product-info"><span class="subtle">'+e(p.brand)+'</span><h3>'+go('/product/'+p.id,e(p.name))+'</h3>'+
    '<div class="price-row"><span>'+(single?'':'<small>'+(direct?e(variant.name):'From')+'</small> ')+'<strong>'+cash(direct?variant.price:productPrice(p))+'</strong></span>'+
    (variant?add:'<span class="subtle">Sold out</span>')+'</div></div></article>';
}
export const grid = (rows,options) => '<div class="product-grid">'+rows.map(product=>card(product,options)).join('')+'</div>';
export function home() {
  const featured=state.products.filter(p=>p.featured&&p.status==='Published').slice(0,8);
  const config=homepageSettings();
  const heroProducts=config.heroProductIds.length?config.heroProductIds.map(findProduct).filter(p=>p?.status==='Published').slice(0,3):featured.slice(0,3);
  const shownCategories=categories.filter(([id])=>config.categoryIds.includes(id));
  const visual=heroProducts.map((p,i)=>'<figure class="hero-tile tile-'+i+'"><img src="'+e(imageUrl(p.image))+'" alt=""></figure>').join('');
  return '<section class="hero"><div class="hero-copy"><p class="overline">'+e(config.eyebrow)+'</p><h1>'+e(config.title).replaceAll('\n','<br>')+'</h1><p class="hero-desc">'+e(config.description)+'</p><div class="button-row">'+go(config.primaryPath,e(config.primaryLabel)+' <span>↗</span>','btn primary')+(config.secondaryLabel?go(config.secondaryPath,e(config.secondaryLabel),'btn outline'):'')+'</div></div><div class="hero-media" aria-hidden="true">'+visual+'</div></section>'+
    (shownCategories.length?'<section class="section"><div class="section-title"><h2>'+e(config.categoryTitle)+'</h2>'+go('/categories','View all categories ↗','text-link')+'</div>'+categoriesGrid(shownCategories)+'</section>':'')+
    '<section class="section"><div class="section-title"><h2>Everyday favourites</h2>'+go('/shop','Browse all products ↗','text-link')+'</div>'+(featured.length?grid(featured,{quickAdd:true}):empty('No featured products','Browse the full assortment.',go('/shop','Shop all','btn primary')))+'</section>';
}
export const allCategories=()=>crumb('Categories')+'<div class="page-title"><h1>Shop by category</h1></div>'+categoriesGrid();
export function catalog(path,params,id='') {
  const q=params.get('q')??'', brand=params.get('brand')??'', sort=params.get('sort')??'featured';
  const all=matching(q).filter(p=>!id||p.category===id);
  const brands=[...new Set(all.map(p=>p.brand))].sort();
  const rows=all.filter(p=>!brand||p.brand===brand).sort((a,b)=>
    sort==='price-up'?productPrice(a)-productPrice(b):sort==='price-down'?productPrice(b)-productPrice(a):
    sort==='name'?a.name.localeCompare(b.name):Number(b.featured)-Number(a.featured));
  const title=q?'Search results':id?categoryName(id):'All products';
  return crumb(e(title))+'<div class="page-title"><h1>'+e(title)+'</h1><p>'+rows.length+' product'+(rows.length===1?'':'s')+(q?' for “'+e(q)+'”':'')+'</p></div>'+
    '<div class="filters"><label>Category <select id="category-filter"><option value="#/shop">All categories</option>'+
    categories.map(([cat,name])=>'<option value="'+e(href('/category/'+cat,q?{q}:{}))+'"'+selected(cat,id)+'>'+e(name)+'</option>').join('')+'</select></label>'+
    '<form id="catalog-filters" data-path="'+e(path)+'"><input type="hidden" name="q" value="'+e(q)+'"><label>Brand <select name="brand"><option value="">All brands</option>'+
    brands.map(b=>'<option'+selected(b,brand)+'>'+e(b)+'</option>').join('')+'</select></label><label>Sort by <select name="sort">'+
    [['featured','Featured'],['price-up','Price · low to high'],['price-down','Price · high to low'],['name','Name · A to Z']].map(([k,v])=>'<option value="'+k+'"'+selected(k,sort)+'>'+v+'</option>').join('')+'</select></label></form></div>'+
    (rows.length?grid(rows):empty('No matching products','Try another keyword, or browse all products.',go('/shop','Shop all','btn primary')));
}
export function detail(p, params) {
  if(!p||p.status!=='Published') return missing();
  const v=p.variants.find(v=>v.sku===params.get('sku'))??p.variants[0], available=v.stock>=v.min;
  const related=state.products.filter(x=>x.id!==p.id&&x.status==='Published'&&x.category===p.category).slice(0,4);
  return crumb(go('/category/'+p.category,e(categoryName(p.category))),e(p.name))+
    '<section class="detail">'+photo(p,'detail-photo',v)+'<div class="detail-copy"><div class="overline">'+e(p.brand)+'</div><h1>'+e(p.name)+'</h1><p class="detail-price">'+cash(v.price)+'</p><p>'+e(p.description)+'</p>'+
    (p.variants.length>1?'<fieldset><legend>Pack size</legend><div class="variant-row">'+p.variants.map(row=>'<span class="variant-choice">'+photo(p,'variant-thumb',row)+link(href('/product/'+p.id,{sku:row.sku}),e(row.name),'btn '+(row.sku===v.sku?'chosen':'outline'))+'</span>').join('')+'</div></fieldset>':'')+
    '<p class="stock-note">'+(available?v.stock+' in stock · Minimum '+v.min:'Currently unavailable')+' <span>SKU '+e(v.sku)+'</span></p>'+
    '<form id="add-to-cart" data-sku="'+e(v.sku)+'" class="button-row"><label class="qty-label">Qty <input aria-label="Quantity" name="qty" type="number" min="'+v.min+'" max="'+v.stock+'" value="'+v.min+'" required '+(available?'':'disabled')+'></label><button class="btn primary" '+(available?'':'disabled')+'>Add to basket</button><button type="button" class="btn outline" data-save="'+e(p.id)+'" aria-pressed="'+state.saved.includes(p.id)+'">'+icon('heart')+' '+(state.saved.includes(p.id)?'Saved':'Save')+'</button></form>'+
    '<div class="detail-delivery">'+icon('truck')+' '+go('/delivery','Singapore delivery · Details')+'</div></div></section>'+
    (related.length?'<section class="section"><div class="section-title"><h2>More in '+e(categoryName(p.category))+'</h2></div>'+grid(related)+'</section>':'');
}
export function summary(amounts,checkout=false) {
  return  '<aside class="panel summary"><h2>Order summary</h2>'+
    (checkout?orderItemsPreview(cartLines().map(({sku,product,variant,qty})=>({productId:product?.id,sku,name:product?.name??sku,option:variant?.name??'Unavailable',qty}))):'')+'<dl><div><dt>Subtotal</dt><dd>'+cash(amounts.subtotal)+'</dd></div><div><dt>Delivery</dt><dd>'+cash(amounts.shipping)+'</dd></div>'+
    (amounts.discount?'<div><dt>Discount</dt><dd>−'+cash(amounts.discount)+'</dd></div>':'')+
    '<div class="total"><dt>Total</dt><dd>'+cash(amounts.total)+'</dd></div></dl>'+
    (checkout?'<p class="subtle">Amounts are in SGD.</p>':go('/checkout','Continue to checkout ↗','btn primary full'))+'</aside>';
}
function repurchaseNotice(result) {
  if(!result?.skipped.length) return '';
  return '<div class="notice repurchase-notice" role="status"><strong>'+
    (result.added?result.added+' '+(result.added===1?'unit':'units')+' added to your basket.':'No items could be added to your basket.')+
    '</strong><ul>'+result.skipped.map(item=>'<li>'+e(item.name)+(item.option?' · '+e(item.option):'')+' — '+e(item.error)+'</li>').join('')+'</ul></div>';
}
export function cart(repurchase) {
  const rows=cartLines(), amounts=totals();
  return crumb(go('/account','My Account'),'Basket')+'<div class="page-title"><h1>Your basket</h1></div>'+repurchaseNotice(repurchase)+(!rows.length?empty('Your basket is empty','Browse the shop to add something.',go('/shop','Continue shopping','btn primary')):
    '<div class="two-col"><section class="panel">'+rows.map(({sku,qty,product,variant})=>'<article class="cart-line">'+
    (product?photo(product,'mini',variant):'<div></div>')+'<div><h3>'+(product?go('/product/'+product.id,e(product.name)):e(sku))+'</h3><p class="subtle">'+(variant?e(variant.name)+' · '+cash(variant.price):'Unavailable')+'</p>'+
    '<div class="button-row"><button class="btn small outline" data-quantity="'+e(sku)+'" data-delta="-1" aria-label="Decrease quantity">−</button><span>'+qty+'</span><button class="btn small outline" data-quantity="'+e(sku)+'" data-delta="1" aria-label="Increase quantity">+</button><button class="link-button" data-remove="'+e(sku)+'">Remove</button></div></div><strong>'+(variant?cash(variant.price*qty):'—')+'</strong></article>').join('')+
    '<form id="coupon-form" class="coupon-form"><label>Coupon code <input name="code" value="'+e(state.coupon)+'" placeholder="Enter code" maxlength="24"></label><button class="btn outline">Apply</button></form>'+
    (state.coupon?'<p class="subtle">'+(amounts.valid?e(state.coupon)+' is applied.':'Coupon requirements are currently unmet.')+'</p>':'')+'</section>'+summary(amounts)+'</div>');
}
export function checkout() {
  if(!cartLines().length) return empty('Your basket is empty','Add products before checking out.',go('/shop','Browse products','btn primary'));
  if(!state.account) return crumb('Checkout')+empty('Sign in to check out','Use a sample name and email to try the checkout.',link(href('/account',{next:'checkout'}),'Sign in to the demo','btn primary'));
  return crumb(go('/cart','Basket'),'Checkout')+'<div class="page-title"><h1>Checkout</h1><p>Simulated checkout. Use sample delivery details.</p></div><div class="two-col"><form class="panel form-stack" id="checkout-form"><h2>Delivery details</h2>'+
    '<label>Full name<input name="name" value="'+e(state.account.name)+'" required maxlength="80"></label><label>Email<input type="email" value="'+e(state.account.email)+'" readonly></label>'+
    '<label>Address and unit<input name="address" placeholder="Example: 10 Sample Street #02-01" required maxlength="200"></label><label>Singapore postal code<input name="postal" inputmode="numeric" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required></label>'+
    '<div class="notice">Payment method · Simulated payment</div><button class="btn primary">Place demo order</button></form>'+summary(totals(),true)+'</div>';
}
function accountSignIn(next='') {
  return '<form class="panel form-stack narrow" id="account-form" data-next="'+e(next)+'"><h2>Demo sign-in</h2><p class="subtle">Use any sample name and email.</p><label>Name<input name="name" placeholder="Sample Shopper" required maxlength="80"></label><label>Email address<input name="email" type="email" placeholder="shopper@example.test" required maxlength="120"></label><button class="btn primary">Sign in</button><button class="btn outline" type="button" data-demo-login>Use sample shopper</button></form>';
}
const purchaseTabs={receive:'To Receive',rate:'To Rate'};
const trackingStages=[
  {key:'to-ship',label:'To Ship',glyph:'box',status:'Processing',empty:'Orders being prepared will appear here.'},
  {key:'shipping',label:'Shipping',glyph:'truck',status:'Shipped',empty:'Dispatched orders will appear here.'},
  {key:'delivered',label:'Delivered',glyph:'delivered',status:'Delivered',empty:'Delivered orders will appear here.'}
];
function buyerShortcut(label,glyph,destination,count,active=false) {
  return '<a class="buyer-shortcut" href="'+e(destination)+'"'+(active?' aria-current="page"':'')+'><span class="buyer-shortcut-icon">'+icon(glyph)+
    (count?'<span class="buyer-count" aria-label="'+count+(count===1?' item':' items')+'">'+count+'</span>':'')+'</span><span>'+e(label)+'</span></a>';
}
function purchaseShortcuts(orders) {
  const items=Object.values(state.cart).reduce((sum,qty)=>sum+qty,0);
  const shortcuts=[
    ['Saved Items','heart',href('/saved'),state.products.filter(p=>p.status==='Published'&&state.saved.includes(p.id)).length],
    ['In Cart','bag',href('/cart'),items],
    ['To Receive','truck',href('/orders',{view:'receive'}),orders.filter(o=>o.status==='Shipped').length],
    ['To Rate','star',href('/orders',{view:'rate'}),orders.reduce((sum,o)=>sum+pendingReviewItems(o).length,0)],
    ['Coupon','coupon',href('/offers'),state.coupons.filter(c=>c.active).length]
  ];
  return '<section class="panel buyer-purchases" aria-labelledby="buyer-purchases-title"><div class="section-title"><h2 id="buyer-purchases-title">My Purchases</h2>'+
    go('/orders','View Purchase History <span aria-hidden="true">›</span>','text-link')+'</div>'+
    '<nav class="buyer-shortcuts" aria-label="Purchase shortcuts">'+shortcuts.map(args=>buyerShortcut(...args)).join('')+'</nav></section>';
}
function buyerProductTiles(rows) {
  return '<div class="buyer-products">'+rows.map(({product,variant,name,option,destination})=>
    '<article class="buyer-product">'+photo(product,'buyer-product-photo',variant)+'<h3>'+
    (destination?link(destination,e(name)):e(name))+'</h3>'+(option?'<p class="subtle">'+e(option)+'</p>':'')+'</article>'
  ).join('')+'</div>';
}
function recentlyViewedProducts() {
  return (state.recentlyViewed??[]).map(({id,sku})=>{
    const product=findProduct(id);
    if(product?.status!=='Published') return null;
    const variant=product.variants.find(v=>v.sku===sku);
    return {product,variant,name:product.name,option:variant?.name,destination:href('/product/'+id,variant?{sku:variant.sku}:{})};
  }).filter(Boolean);
}
function buyerProductSection(title,rows,emptyText,action='') {
  return '<section class="panel buyer-product-section"><div class="section-title"><h2>'+title+'</h2>'+action+'</div>'+
    (rows.length?buyerProductTiles(rows):'<p class="buyer-empty subtle">'+emptyText+'</p>')+'</section>';
}
export function account(params) {
  const a=state.account;
  const title='<div class="page-title buyer-account-title"><div><h1>My account</h1>';
  if(!a) return crumb('My account')+'<div class="buyer-dashboard">'+title+'</div></div>'+
    accountSignIn(params.get('next')??'')+'</div>';
  const purchases=buyerOrders(), recentlyViewed=recentlyViewedProducts();
  return crumb('My account')+'<div class="buyer-dashboard">'+title+
    '<p>'+e(a.name)+' <span class="subtle">· '+e(a.email)+'</span></p></div>'+
    '<button class="btn outline small" data-sign-out>Sign out</button></div>'+
    purchaseShortcuts(purchases)+
    buyerProductSection('Recently Viewed',recentlyViewed.slice(0,6),'Products you open will appear here.',
      recentlyViewed.length>6?go('/recently-viewed','View all <span aria-hidden="true">›</span>','text-link'):'')+'</div>';
}
export function recentlyViewedPage() {
  return crumb(go('/account','My account'),'Recently Viewed')+'<div class="buyer-dashboard"><div class="page-title"><h1>Recently Viewed</h1></div>'+
    buyerProductSection('Products',recentlyViewedProducts(),'Products you open will appear here.')+'</div>';
}
function trackingStageNav(orders,current) {
  return '<nav class="panel tracking-stage-nav" aria-label="Shipping status">'+trackingStages.map(stage=>
    buyerShortcut(stage.label,stage.glyph,href('/orders',{view:'receive',stage:stage.key}),
      orders.filter(o=>o.status===stage.status).length,stage===current)
  ).join('')+'</nav>';
}
function buyerTrackingSteps(status) {
  const current=trackingStages.findIndex(stage=>stage.status===status);
  return '<ol class="tracking-steps buyer-tracking-steps" aria-label="Order progress">'+trackingStages.map((stage,i)=>
    '<li class="'+(i<=current?'done':'')+'"'+(i===current?' aria-current="step"':'')+'>'+icon(stage.glyph)+'<span>'+stage.label+'</span></li>'
  ).join('')+'</ol>';
}
function receivedButton(order) {
  return '<button type="button" class="btn primary small" data-receive-order="'+e(order.id)+'" aria-label="Received order '+e(order.id)+'">Received</button>';
}
function receiveOrderRow(order,stage) {
  const tracking=href('/orders',{view:'receive',stage:stage.key,id:order.id});
  const pictures=order.items.map(item=>{
    const product=findProduct(item.productId)??{name:item.name};
    return '<li>'+photo(product,'receive-order-thumb',product.variants?.find(variant=>variant.sku===item.sku))+'</li>';
  }).join('');
  const status=order.status==='Delivered'?'Received':stage.label;
  return '<article class="panel receive-order-row"><div class="receive-order-info"><div class="receive-order-heading"><h2>'+
    link(tracking,e(order.id))+'</h2><time class="subtle" datetime="'+e(order.date)+'">'+e(order.date)+'</time></div>'+
    '<ul class="receive-order-products" aria-label="Products in '+e(order.id)+'">'+pictures+'</ul></div>'+
    '<div class="receive-order-actions">'+badge(order.status,status)+link(tracking,'Track order','text-link')+
    (order.status==='Shipped'?receivedButton(order):'')+'</div></article>';
}
function rateOrderCard(order) {
  const content=pendingReviewItems(order).map(item=>
    '<li>'+orderItemLabel(item)+'<button type="button" class="btn primary small" data-rate-order="'+e(order.id)+'" data-rate-sku="'+e(item.sku)+'">Rate product<span class="sr-only">: '+e(item.name)+'</span></button></li>'
  ).join('');
  return '<section class="panel buyer-status-order"><div class="section-title"><h2>'+e(order.id)+'</h2>'+badge(order.status)+'</div>'+
    '<ul class="order-items">'+content+'</ul><div class="button-row">'+link(href('/orders',{id:order.id}),'View order','btn outline small')+'</div></section>';
}
export function buyerReviewDialog(orderId,item) {
  return '<form id="buyer-review-form" class="form-stack" data-order="'+e(orderId)+'" data-sku="'+e(item.sku)+'"><h2 id="dialog-title">Rate product</h2>'+
    orderItemLabel(item)+'<label>Rating<select name="rating" required><option value="">Choose a rating</option>'+
    [5,4,3,2,1].map(n=>'<option value="'+n+'">'+n+' / 5</option>').join('')+'</select></label>'+
    '<label>Review (optional)<textarea name="comment" maxlength="500" rows="3"></textarea></label><button class="btn primary">Submit rating</button></form>';
}
function repurchaseButton(order) {
  return '<button type="button" class="btn outline small" data-repurchase="'+e(order.id)+'" aria-label="Repurchase order '+e(order.id)+'">Repurchase</button>';
}
export function orders(params=new URLSearchParams()) {
  const view=params.get('view');
  const id=(params.get('id')??'').trim().toUpperCase();
  const label=Object.hasOwn(purchaseTabs,view)?purchaseTabs[view]:id?'Order details':'Purchase History';
  const nav=crumb(go('/account','My account'),label)+'<div class="page-title"><h1>'+label+'</h1></div>';
  if(!state.account) return nav+empty('Sign in to see your orders','Use your demo account to view purchases.',go('/account','Sign in','btn primary'));
  const purchases=buyerOrders();
  const order=id?purchases.find(o=>o.id===id):null;
  const stage=trackingStages.find(item=>item.key===params.get('stage'))??
    trackingStages.find(item=>item.status===order?.status)??trackingStages[1];
  const stageNav=view==='receive'?trackingStageNav(purchases,stage):'';
  if(id) {
    const back=link(href('/orders',view==='receive'?{view,stage:stage.key}:{}),view==='receive'?'Back to To Receive':'Back to Purchase History','btn outline small');
    return nav+'<div class="buyer-dashboard">'+stageNav+
      (order?orderDisplay(order,{buyerTracking:view==='receive'}):'<p class="notice">Order not found in your account.</p>')+
      '<div class="button-row">'+back+(view==='receive'&&order?.status==='Shipped'?receivedButton(order):'')+
      (!view&&order?repurchaseButton(order):'')+'</div></div>';
  }
  if(view==='receive'||view==='rate') {
    const rows=purchases.filter(order=>view==='receive'?order.status===stage.status:pendingReviewItems(order).length);
    const emptyCopy=view==='receive'?['No orders in '+stage.label,stage.empty]:
      ['No products to rate','Products from delivered orders will appear here.'];
    return nav+'<div class="buyer-dashboard buyer-status-list">'+stageNav+
      (rows.length?rows.map(order=>view==='receive'?receiveOrderRow(order,stage):rateOrderCard(order)).join(''):
        empty(emptyCopy[0],emptyCopy[1],go('/orders','View Purchase History','btn outline')))+'</div>';
  }
  return nav+(!purchases.length?empty('No orders yet','Orders you place in this browser appear here.',go('/shop','Browse products','btn primary')):
    '<div class="panel table-wrap"><table><thead><tr><th>Order</th><th>Products</th><th>Date</th><th>Status</th><th>Total</th><th></th></tr></thead><tbody>'+purchases.map(o=>'<tr><td>'+e(o.id)+'</td><td>'+orderItemsPreview(o.items,{showRating:true})+'</td><td>'+e(o.date)+'</td><td>'+badge(o.status)+'</td><td>'+cash(o.totals.total)+'</td><td><div class="purchase-history-actions">'+link(href('/orders',{id:o.id}),'View order ↗','text-link')+repurchaseButton(o)+'</div></td></tr>').join('')+'</tbody></table></div>');
}
export function orderDisplay(o,{buyerTracking=false}={}) {
  if(!o) return '';
  const stage=buyerTracking?trackingStages.find(item=>item.status===o.status):null;
  const tracking=o.tracking||(buyerTracking&&o.status!=='Processing'?'Not available':'Awaiting shipment');
  return '<div class="panel order-display"><div class="section-title"><div><h2>'+e(o.id)+'</h2><p class="subtle">'+e(o.date)+'</p></div>'+badge(o.status,buyerTracking&&o.status==='Delivered'?'Received':stage?.label)+'</div>'+
    (o.status==='Cancelled'?'':buyerTracking?buyerTrackingSteps(o.status):'<ol class="tracking-steps">'+statusList.slice(0,3).map((s,i)=>'<li class="'+(i<=statusList.indexOf(o.status)?'done':'')+'">'+s+'</li>').join('')+'</ol>')+
    '<p>Tracking number <strong>'+e(tracking)+'</strong></p><ul class="order-items">'+o.items.map(i=>'<li>'+orderItemLabel(i)+'<strong>'+cash(i.price*i.qty)+'</strong></li>').join('')+'</ul><p class="order-total">Total <strong>'+cash(o.totals.total)+'</strong></p></div>';
}
export function confirmation(params) {
  const id=(params.get('id')??'').trim().toUpperCase();
  const order=buyerOrders().find(o=>o.id===id);
  return crumb('Order confirmed')+(order?
    '<div class="page-title"><h1>Demo order placed</h1><p>Your order is ready for processing in the admin preview.</p></div>'+orderDisplay(order)+
    '<div class="button-row order-actions">'+link(href('/orders',{view:'receive',id}),'Track order in To Receive','btn primary')+
    go('/admin/orders/'+id,'View in admin','btn outline')+'</div>':
    empty('Order not found','Check your purchase history.',go('/orders','View Purchase History','btn primary')));
}
export const savedPage=()=>crumb(go('/account','My Account'),'Saved items')+'<div class="page-title"><h1>Saved items</h1></div>'+
  (state.products.some(p=>p.status==='Published'&&state.saved.includes(p.id))?grid(state.products.filter(p=>p.status==='Published'&&state.saved.includes(p.id))):empty('No saved items','Save products using the heart on any product card.',go('/shop','Browse products','btn primary')));
export function offers() {
  const active=state.coupons.filter(c=>c.active);
  return crumb(go('/account','My Account'),'Offers')+'<div class="page-title"><h1>Offers</h1><p>Demo coupons for your shopping basket.</p></div>'+
    (active.length?'<div class="offer-grid">'+active.map(c=>'<article class="panel offer sage"><div class="overline">'+e(c.code)+'</div><h2>'+(c.type==='shipping'?'Free delivery':c.type==='fixed'?cash(c.amount)+' off':c.amount+'% off')+'</h2><p>Minimum basket subtotal '+cash(c.min)+'</p><button class="btn primary" data-copy="'+e(c.code)+'">Use this code</button></article>').join('')+'</div>':empty('No current offers','Browse everyday prices in the shop.',go('/shop','Shop all','btn primary')));
}
const pages={
  about:['About CP Value Mart','<h2>Everyday essentials in Singapore</h2><p>CP Value Mart brings together personal care, household cleaning, tissues and pantry essentials in one storefront. Shop by category, filter by brand or search for a product directly.</p>'],
  delivery:['Delivery & returns',()=>'<h2>Singapore delivery</h2><p>Standard delivery is '+cash(state.settings.shipping)+'. Delivery is free when your merchandise subtotal reaches '+cash(state.settings.threshold)+'.</p><h2>Track your delivery</h2><p>In My account, open To Receive to see shipment status and tracking numbers.</p>'+link(href('/orders',{view:'receive'}),'Open To Receive ↗','text-link')+'<h2>Returns</h2><p>For a damaged or incorrect item, contact customer care with your order number and item details. These are demonstration policies.</p>'],
  faq:['Frequently asked questions','<details open><summary>How do I find a brand?</summary><p>Select a category, then use the Brand filter. You can also enter a brand or SKU in search.</p></details><details><summary>Why do some items require more than one unit?</summary><p>Minimum quantities can vary by pack. Check the selected pack on the product page.</p></details><details><summary>How do I track my order?</summary><p>Sign in and open To Receive in My account. The tracking number appears after your order ships.</p></details><details><summary>Will I be charged?</summary><p>The preview simulates checkout using sample data.</p></details>'],
  privacy:['Privacy','<h2>Preview data</h2><p>The preview saves the shopping basket, sample profile, orders and admin changes in the current browser. Use sample names, emails and addresses.</p><h2>Reset demo data</h2><p>The admin settings page has a reset option that restores the imported catalogue and clears simulated orders.</p>'],
  terms:['Terms of use','<h2>Design preview</h2><p>Product prices, stock, promotions and delivery policies are examples. Orders placed here are simulations.</p>'],
  contact:['Contact us','<form id="contact-form" class="form-stack"><p>Try the sample customer care form.</p><label>Email <input name="email" type="email" required maxlength="120"></label><label>Order number <input name="order" maxlength="24"></label><label>Message <textarea name="message" required maxlength="1000" rows="5"></textarea></label><button class="btn primary">Submit demo enquiry</button><p id="contact-status" role="status"></p></form>']
};
export function info(key) {
  const row=pages[key];
  return row?crumb(row[0])+'<div class="page-title"><h1>'+row[0]+'</h1></div><article class="panel prose">'+(typeof row[1]==='function'?row[1]():row[1])+'</article>':missing();
}
export const missing=()=>empty('Page not found','Browse the shop or return to the home page.',go('/','Back to home','btn primary'));
