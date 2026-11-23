import {catalogProducts} from './catalog.js';

export const categories = [
  ['personal-care','Personal Care','✳','sage'], ['hair-care','Hair Care','✿','lilac'],
  ['oral-care','Oral Care','✦','blue'], ['skin-care','Skin Care','◇','peach'],
  ['home-cleaning','Home Cleaning','▧','sage'], ['laundry','Laundry','◈','blue'],
  ['paper-tissues','Paper & Tissues','▤','sand'], ['baby-family','Baby & Family','♡','peach'],
  ['food-pantry','Food & Pantry','◍','sand'], ['snacks-drinks','Snacks & Drinks','✺','lilac'],
  ['others','Others','＋','sage']
];
export const cash = cents => 'S$' + (cents / 100).toFixed(2);
export const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
export const categoryName = id => categories.find(c => c[0] === id)?.[1] ?? 'Others';
export const stock = product => product.variants.reduce((sum, row) => sum + row.stock, 0);
export const productPrice = product => Math.min(...product.variants.map(row => row.price));
export const statusList = ['Processing','Shipped','Delivered','Cancelled'];
export const orderDate = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',dateStyle:'short'}).format(new Date());
export const imageUrl = value => {
  const url = String(value ?? '').trim();
  return /^(https:\/\/[^\s]+|assets\/[a-z0-9_-]+\.webp)$/i.test(url) ? url : '';
};

export const homepageDefaults = {
  eyebrow:'CP VALUE MART · SINGAPORE',title:'Everyday essentials,\nwithin easy reach.',
  description:'Shop personal care, household favourites and pantry staples in one place.',
  primaryLabel:'Shop all products',primaryPath:'/shop',secondaryLabel:'View offers',secondaryPath:'/offers',
  categoryTitle:'Shop by category',categoryIds:categories.map(([id])=>id),heroProductIds:[]
};
export const homepageSettings = () => ({...homepageDefaults,...state.settings.homepage});

function splitProducts(products) {
  return products.flatMap(product => product.variants.map((variant,index) => {
    if(product.variants.length===1 && product.id===variant.sku) return product;
    const image=variant.image||product.image;
    return {
      ...product,id:variant.sku,sku:variant.sku,
      name:product.name+' · '+variant.name,
      description:product.description+' · '+variant.name,
      keywords:[product.keywords,variant.name].filter(Boolean).join(' '),
      image,original:image,r2:image,featured:Boolean(product.featured&&index===0),
      variants:[{...variant}]
    };
  }));
}
function demoData() {
  const products = splitProducts(catalogProducts);
  return {
    products,orders:[],adminOrders:[],cart:{},saved:[],recentlyViewed:[],account:null,nextOrder:1044,searches:{},coupon:'',
    settings:{shipping:390,threshold:5000,support:'hello@cpvaluemart.com'},
    coupons:[
      {code:'WELCOME5',type:'percent',amount:5,min:2000,active:true},
      {code:'SHIPFREE',type:'shipping',amount:0,min:3500,active:true}
    ]
  };
}
export const previewStorageKey='cvm-preview-13m-20261118-v1';
export const obsoletePreviewStorageKey='cvm-preview-2026-v2';
const preferenceKeys=['products','cart','saved','recentlyViewed','searches','coupon','settings','coupons'];
const browserPreferences=source=>Object.fromEntries(preferenceKeys.filter(k=>Object.hasOwn(source,k)).map(k=>[k,source[k]]));
export let state=demoData();
export function loadPreviewPreferences({storageEvent=false}={}) {
  try {
    localStorage.removeItem(obsoletePreviewStorageKey);
    const raw=localStorage.getItem(previewStorageKey);
    if(raw===null)return;
    let stored;
    try {stored=JSON.parse(raw);} catch {}
    if(!stored||typeof stored!=='object'||Array.isArray(stored)){
      if(localStorage.getItem(previewStorageKey)===raw)localStorage.removeItem(previewStorageKey);
      return;
    }
    const preferences=browserPreferences(stored);
    if(Object.keys(stored).length!==Object.keys(preferences).length){
      if(localStorage.getItem(previewStorageKey)!==raw)return;
      localStorage.setItem(previewStorageKey,JSON.stringify(preferences));
    }
    if(storageEvent){
      if(typeof preferences.coupon==='string')state.coupon=preferences.coupon;
      return;
    }
    if(state.account){delete preferences.cart;delete preferences.saved;delete preferences.recentlyViewed;}
    if(Array.isArray(preferences.products)&&preferences.settings)Object.assign(state,preferences);
  } catch {}
}
loadPreviewPreferences();
try {
  if(state.products.some(p=>p.variants.length!==1||p.id!==p.variants[0].sku)) {
    const oldProducts=state.products;
    const firstSku=new Map(oldProducts.map(p=>[p.id,p.variants[0]?.sku]));
    state.products=splitProducts(oldProducts);
    state.saved=(state.saved??[]).map(id=>firstSku.get(id)??id).filter(Boolean);
    state.recentlyViewed=(state.recentlyViewed??[]).map(item=>({id:item.sku??firstSku.get(item.id)??item.id,sku:item.sku}));
    save();
  }
} catch { state=demoData(); }
export function save() {
  try { localStorage.setItem(previewStorageKey,JSON.stringify({...browserPreferences(state),
    ...(state.account?{cart:{},saved:[],recentlyViewed:[]}:{})})); } catch {}
}
export function reset() { state=demoData(); save(); }
export function findProduct(id) { return state.products.find(p=>p.id===id); }
export function getVariant(sku) {
  for (const product of state.products) {
    const variant=product.variants.find(v=>v.sku===sku);
    if (variant) return {product,variant};
  }
  return null;
}
function cartProblem(row,qty) {
  if(!row||row.product.status!=='Published') return 'This item is unavailable.';
  if(!Number.isSafeInteger(qty)||qty<row.variant.min) return 'Minimum quantity is '+row.variant.min+'.';
  if(qty>row.variant.stock) return 'Only '+row.variant.stock+' available.';
}
export function setCart(sku, qty) {
  if (!qty) { delete state.cart[sku]; save(); return; }
  const error=cartProblem(getVariant(sku),qty);
  if(error) return error;
  state.cart[sku]=qty;
  save();
}
export function cartLines() {
  return Object.entries(state.cart).map(([sku,qty])=>({sku,qty,...getVariant(sku)}));
}
export function totals(lines=cartLines(), code=state.coupon) {
  const subtotal=lines.reduce((sum,line)=>sum+(line.variant?.price??0)*line.qty,0);
  let shipping=subtotal && subtotal<state.settings.threshold ? state.settings.shipping : 0;
  let discount=0;
  const coupon=state.coupons.find(c=>c.active&&c.code===code);
  const valid=Boolean(coupon&&subtotal>0&&subtotal>=coupon.min);
  if (valid) {
    if (coupon.type==='shipping') shipping=0;
    if (coupon.type==='fixed') discount=Math.min(subtotal,coupon.amount);
    if (coupon.type==='percent') discount=Math.round(subtotal*coupon.amount/100);
  }
  return {subtotal,shipping,discount,total:subtotal+shipping-discount,valid};
}
export function makeOrder(fields) {
  if (!state.account) return {error:'Sign in to complete checkout.'};
  const lines=cartLines();
  if (!lines.length) return {error:'Your basket is empty.'};
  const invalid=lines.some(({product,variant,qty})=>
    product?.status!=='Published'||!variant||qty>variant.stock||qty<variant.min);
  if (invalid) return {error:'An item has changed. Review your basket before placing the order.'};
  const amounts=totals(lines);
  for (const {variant,qty} of lines) variant.stock-=qty;
  const order={
    id:'CVM-'+state.nextOrder++,date:orderDate(),email:state.account.email,
    name:fields.name,address:fields.address,postal:fields.postal,status:'Processing',tracking:'',
    items:lines.map(({product,variant,qty})=>({
      productId:product.id,sku:variant.sku,name:product.name,option:variant.name,price:variant.price,qty
    })),
    totals:amounts
  };
  state.orders.unshift(order); state.cart={}; state.coupon=''; save();
  return {order};
}
const AUTO_RECEIPT_DELAY=3*24*60*60*1000;

export function updateOrder(order,status,tracking,now=Date.now()) {
  if (!statusList.includes(status) || (order.status==='Cancelled'&&status!==order.status)) return 'Cancelled orders are closed.';
  if (status==='Shipped'&&!tracking) return 'Enter a tracking number before marking as shipped.';
  if (status==='Cancelled'&&order.status!=='Cancelled') {
    for (const item of order.items) {
      const row=getVariant(item.sku);
      if (row) row.variant.stock+=item.qty;
    }
  }
  if(status==='Shipped'&&order.status!=='Shipped') order.shippedAt=now;
  if(status==='Delivered'&&order.status!=='Delivered') order.receivedAt=now;
  if(status!=='Delivered') delete order.receivedAt;
  order.status=status; order.tracking=tracking; save();
}
export function syncAutoReceipts(now=Date.now()) {
  let changed=false, nextDue=Infinity;
  for(const order of state.orders) {
    if(order.backendId||order.status!=='Shipped') continue;
    if(!Number.isFinite(order.shippedAt)) {
      order.shippedAt=now;
      changed=true;
    }
    const due=order.shippedAt+AUTO_RECEIPT_DELAY;
    if(now>=due) {
      order.status='Delivered';
      order.receivedAt=due;
      changed=true;
    } else nextDue=Math.min(nextDue,due);
  }
  if(changed) save();
  return {changed,nextDue};
}
export function rememberProduct(product,sku) {
  if(product?.status!=='Published') return;
  const selected=product.variants.find(variant=>variant.sku===sku);
  const previous=state.recentlyViewed??[];
  if(previous[0]?.id===product.id&&previous[0].sku===selected?.sku) return;
  state.recentlyViewed=[{id:product.id,sku:selected?.sku},...previous.filter(item=>item.id!==product.id)].slice(0,12);
  save();
}
export function buyerOrders() {
  return state.account?state.orders.filter(order=>order.email===state.account.email):[];
}
export function repurchaseOrder(id,order=buyerOrders().find(o=>o.id===id)) {
  if(!order) return {error:'Order not found in your account.'};
  const basket={...state.cart};
  const skipped=[];
  let added=0;
  for(const item of order.items) {
    const row=getVariant(item.sku);
    const qty=(basket[item.sku]??0)+item.qty;
    const error=row?.product.id===item.productId?cartProblem(row,qty):'This variant is unavailable.';
    if(error) {
      skipped.push({name:item.name,option:item.option,error});
      continue;
    }
    basket[item.sku]=qty;
    added+=item.qty;
  }
  if(added) {
    state.cart=basket;
    save();
  }
  return {added,skipped};
}
export function pendingReviewItems(order) {
  return order.status==='Delivered'?order.items.filter(item=>!item.review):[];
}
export function confirmBuyerReceipt(id) {
  const order=buyerOrders().find(o=>o.id===id);
  if(order?.status!=='Shipped') return 'This order is unavailable for receipt confirmation.';
  return updateOrder(order,'Delivered',order.tracking);
}
export function reviewItem(id,sku,order=buyerOrders().find(o=>o.id===id)) {
  return order&&pendingReviewItems(order).find(item=>item.sku===sku);
}
export function saveBuyerReview(id,sku,rating,comment,order) {
  const item=reviewItem(id,sku,order);
  if(!item) return 'This item is unavailable for review.';
  if(!Number.isInteger(rating)||rating<1||rating>5) return 'Choose a rating from 1 to 5.';
  item.review={rating,comment:comment.trim().slice(0,500)};
  save();
}
export function matching(query) {
  const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.products.filter(p=>{
    const text=[p.name,p.brand,categoryName(p.category),p.keywords,p.sku,...p.variants.flatMap(v=>[v.sku,v.name])].join(' ').toLowerCase();
    return p.status==='Published'&&terms.every(term=>text.includes(term));
  });
}
export function logSearch(query,count) {
  if (!query) return;
  const term=query.trim().toLowerCase();
  if (!term) return;
  if (!Object.hasOwn(state.searches,term)) Object.defineProperty(state.searches,term,{value:{count:0,misses:0},enumerable:true});
  const row=state.searches[term];
  row.count++; if (!count) row.misses++; save();
}
