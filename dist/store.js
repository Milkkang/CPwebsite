export const categories = [
  ['personal-care','Personal Care','✳','sage'], ['hair-care','Hair Care','✿','lilac'],
  ['oral-care','Oral Care','✦','blue'], ['skin-care','Skin Care','◇','peach'],
  ['home-cleaning','Home Cleaning','▧','sage'], ['laundry','Laundry','◈','blue'],
  ['paper-tissues','Paper & Tissues','▤','sand'], ['baby-family','Baby & Family','♡','peach'],
  ['food-pantry','Food & Pantry','◍','sand'], ['snacks-drinks','Snacks & Drinks','✺','lilac'],
  ['others','Others','＋','sage']
];
const seeds = [
  ['Vaseline Gluta-Hya Body Lotion','Vaseline','skin-care',9.90,24,1,'body lotion serum 身体乳','11'],
  ['Listerine Cool Mint Mouthwash','Listerine','oral-care',3.50,32,1,'mouthwash rinse 漱口水','24'],
  ['Nivea Soft Moisturising Cream','Nivea','skin-care',7.90,16,1,'face hand body cream 面霜','17'],
  ['Super Wet Wipes','Sanmex','paper-tissues',4.50,28,1,'wet tissue 湿纸巾','25'],
  ['Nivea Fresh Energy Deodorant','Nivea','personal-care',5.90,26,1,'spray deodorant 止汗','22'],
  ['Vaseline Cocoa Radiant Lotion','Vaseline','skin-care',8.90,14,1,'cocoa body lotion 身体乳','19'],
  ['Carefree Panty Liners','Carefree','personal-care',4.20,25,2,'liners hygiene 护垫','14'],
  ['Kotex Liners Daily Protect','Kotex','personal-care',4.90,8,1,'liners hygiene 护垫','display'],
  ['Silky Smooth Shampoo','Sunsilk','hair-care',9.90,27,1,'shampoo hair wash 洗发水 洗头水'],
  ['Anti-Dandruff Shampoo','Head & Shoulders','hair-care',12.50,17,1,'shampoo dandruff h&s 海飞丝 洗发水'],
  ['Nourishing Conditioner','Pantene','hair-care',11.90,8,1,'conditioner 护发素'],
  ['Fresh Mint Toothpaste','Colgate','oral-care',4.90,56,2,'toothpaste dental 牙膏 高露洁'],
  ['Multi Care Toothpaste','Darlie','oral-care',5.80,23,1,'toothpaste 牙膏 黑人牙膏'],
  ['All Purpose Surface Spray','Magiclean','home-cleaning',7.90,24,1,'cleaner 清洁剂'],
  ['Dishwashing Liquid','Mama Lemon','home-cleaning',4.20,45,1,'dish soap 洗碗液'],
  ['Fresh Laundry Liquid','Attack','laundry',13.90,21,1,'detergent 洗衣液'],
  ['Fabric Softener','Downy','laundry',10.50,10,1,'softener 柔顺剂'],
  ['Soft Facial Tissue Box','Kleenex','paper-tissues',5.90,49,2,'tissue paper 纸巾'],
  ['Gentle Baby Wipes','Pigeon','baby-family',7.50,26,1,'baby wipes 婴儿湿巾'],
  ['Baby Bath Wash','Johnson’s','baby-family',8.90,7,1,'baby wash 婴儿沐浴露'],
  ['Golden Honey','Naturel','food-pantry',9.90,16,1,'honey 蜂蜜'],
  ['Instant Oatmeal','Quaker','food-pantry',5.90,22,1,'oats 燕麦'],
  ['Butter Cookies','Khong Guan','snacks-drinks',4.90,34,1,'cookies biscuit 饼干'],
  ['Chocolate Malt Drink','Milo','snacks-drinks',7.90,28,1,'drink milo 美禄'],
  ['Reusable Shopping Bag','CP Value Mart','others',4.50,50,1,'bag 购物袋']
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

function demoData() {
  const products = seeds.map(([name,brand,category,price,units,min,keywords,photo], i) => {
    const sku = 'CP-' + String(101+i);
    return {
      id: sku, sku, name, brand, category, keywords, status:'Published', featured:i<8,
      description: name + ' from ' + brand + '. Choose a pack size to see the price, minimum quantity and availability.',
      image:photo ? 'assets/'+photo+'.webp' : '', original:photo ? 'CP Value Mart product '+photo+'.png' : '',
      r2:photo ? 'products/'+sku.toLowerCase()+'/main.webp' : '',
      variants:[
        {sku:sku+'-01',name:'Standard',price:Math.round(price*100),stock:units,min},
        {sku:sku+'-02',name:'Value Pack',price:Math.round(price*1.8*100),stock:Math.floor(units/2),min:1}
      ]
    };
  });
  const orders = ['Processing','Shipped','Delivered'].map((status, i) => {
    const product=products[i], variant=product.variants[0], subtotal=variant.price;
    return {
      id:'CVM-104'+(i+1),date:'2026-11-'+(15+i),name:['Amelia Tan','Daniel Lim','Sarah Lee'][i],
      address:'Demo address',postal:'123456',email:'sample'+i+'@example.test',status,tracking:i?'SG-DEMO-100'+i:'',
      items:[{productId:product.id,sku:variant.sku,name:product.name,option:variant.name,qty:1,price:subtotal}],
      totals:{subtotal,shipping:390,discount:0,total:subtotal+390}
    };
  });
  return {
    products,orders,cart:{},saved:[],recentlyViewed:[],account:null,nextOrder:1044,searches:{},coupon:'',
    settings:{shipping:390,threshold:5000,support:'hello@cpvaluemart.com'},
    coupons:[
      {code:'WELCOME5',type:'percent',amount:5,min:2000,active:true},
      {code:'SHIPFREE',type:'shipping',amount:0,min:3500,active:true}
    ]
  };
}
const key='cvm-preview-2026-v2';
export let state;
try {
  const stored=JSON.parse(localStorage.getItem(key));
  state=stored?.products && stored?.settings && stored?.orders ? stored : demoData();
} catch { state=demoData(); }
export function save() {
  try { localStorage.setItem(key,JSON.stringify(state)); } catch {}
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
    if(order.status!=='Shipped') continue;
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
export function repurchaseOrder(id) {
  const order=buyerOrders().find(o=>o.id===id);
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
export function reviewItem(id,sku) {
  const order=buyerOrders().find(o=>o.id===id);
  return order&&pendingReviewItems(order).find(item=>item.sku===sku);
}
export function saveBuyerReview(id,sku,rating,comment) {
  const item=reviewItem(id,sku);
  if(!item) return 'This item is unavailable for review.';
  if(!Number.isInteger(rating)||rating<1||rating>5) return 'Choose a rating from 1 to 5.';
  item.review={rating,comment:comment.trim().slice(0,500)};
  save();
}
export function matching(query) {
  const terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return state.products.filter(p=>{
    const text=[p.name,p.brand,categoryName(p.category),p.keywords,p.sku,...p.variants.map(v=>v.sku)].join(' ').toLowerCase();
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
