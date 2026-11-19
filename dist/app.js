import {auth,authForms,adminGate,profilePanel,passwordPanel,addressesPanel,loadAddresses,deliveryAddresses,authRequest,submitAuth,signOut,refreshSession,setAuthListener} from './auth.js';
import {state,save,reset,escape as e,findProduct,getVariant,setCart,totals,matching,logSearch,categories,imageUrl,rememberProduct,confirmBuyerReceipt,reviewItem,saveBuyerReview,syncAutoReceipts,repurchaseOrder} from './store.js';
import {href,home,shopFrame,catalog,detail,cart,checkout,account,orders,recentlyViewedPage,buyerReviewDialog,confirmation,allCategories,savedPage,offers,info,missing} from './shop.js';
import {adminPage,extraVariant,stockEditor,couponEditor,storeCoupon,storeProduct,saveFulfilment,saveSettings,saveHomepage,exportData,exportRevenueReport,revenueDateError,importProducts,bulkUpdate,refreshEditorPhotos,updateInlineProduct,updateInlineStatus} from './admin.js';
import {listingFromApi,catalogRequest,catalogQuery,isNewProductView} from './catalog-client.js';

const app=document.getElementById('app'), toast=document.getElementById('toast'), modal=document.getElementById('dialog');
const imageDialog=document.getElementById('image-dialog');
let lastPath='', lastProductView='', toastTimer, receiptTimer;
let storefront={key:'',data:null,error:null}, pendingStorefront='';
let adminProductsLoaded=false,adminProductsLoading=false,adminProductsError='';
let homepageVersion=0,deliveryVersion=0,couponVersions=new Map();
let ordersOwner='',ordersLoading=false;
let checkoutReturnRefresh='';
function mapOrder(row){return {id:row.number,backendId:row.id,version:row.version,date:String(row.createdAt).slice(0,10),email:row.email??auth.account?.email??'',name:row.name??auth.account?.name??'',address:row.address?.line??'',postal:row.address?.postal??'',status:row.fulfilmentStatus,tracking:row.tracking,
 items:row.items.map(item=>({productId:item.sku,sku:item.sku,name:item.name,option:item.option,price:item.price,qty:item.qty})),
 totals:{subtotal:row.subtotal,shipping:row.shipping,discount:row.discount,total:row.total},paymentStatus:row.paymentStatus,paidAt:row.paidAt};}
async function loadOrders(){
 const owner=auth.account?.id;if(!owner||auth.recoveryOnly)return;
 ordersLoading=true;try{const result=await authRequest('/api/orders');if(auth.account?.id===owner){state.orders=result.orders.map(mapOrder);ordersOwner=owner;}}
 catch(error){message(error.message);}finally{ordersLoading=false;render();}
}
async function refreshCheckoutReturn(sessionId){
 const owner=auth.account?.id;
 if(!owner||!sessionId||checkoutReturnRefresh===sessionId)return;
 checkoutReturnRefresh=sessionId;
 for(let attempt=0;attempt<10&&auth.account?.id===owner;attempt++){
  try{
   await Promise.all([loadMemberShopping(),loadOrders()]);
   if(!Object.keys(state.cart).length&&state.orders.some(order=>order.paymentStatus==='paid'))return;
  }catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
}
async function loadAdminProducts() {
  if(!auth.isAdmin||adminProductsLoading)return;
  adminProductsLoading=true;adminProductsError='';
  try{
    const [result,config,orderResult]=await Promise.all([authRequest('/api/admin/products'),authRequest('/api/admin/config'),authRequest('/api/admin/orders')]);
    state.products=result.products.map(row=>listingFromApi(row,{admin:true}));
    state.settings.homepage=config.homepage?.content??{};
    homepageVersion=config.homepage?.version??0;
    state.settings.shipping=config.delivery?.shipping_cents??0;
    state.settings.threshold=config.delivery?.free_threshold_cents??0;
    deliveryVersion=config.delivery?.version??0;
    state.coupons=config.coupons.map(row=>({code:row.code,type:row.kind,amount:row.amount,min:row.minimum_cents,active:row.active}));
    couponVersions=new Map(config.coupons.map(row=>[row.code,row.version]));
    state.orders=orderResult.orders.map(mapOrder);
    adminProductsLoaded=true;
  }catch(error){adminProductsError=error.message;adminProductsLoaded=false;}
  finally{adminProductsLoading=false;render();}
}
async function writeAdminProduct(sku,version,fields,stock) {
  const result=await authRequest('/api/admin/products',{sku,version,fields,...(stock===undefined?{}:{stock})});
  const product=listingFromApi(result.product,{admin:true});
  rememberListings([product]);
  return product;
}
function homepagePayload(values) {
  const text=name=>String(values.get(name)??'').trim();
  const fields=['eyebrow','title','description','primaryLabel','primaryPath','secondaryLabel','secondaryPath','categoryTitle'];
  const content=Object.fromEntries(fields.map(name=>[name,text(name)]));
  content.categoryIds=[...new Set(values.getAll('categoryId'))];
  content.heroProductIds=[...new Set(values.getAll('heroProductId').filter(Boolean))];
  if(!content.title||!content.primaryLabel||!content.categoryTitle||
    content.heroProductIds.length>3||content.heroProductIds.some(id=>findProduct(id)?.status!=='Published')||
    content.categoryIds.some(id=>!categories.some(([key])=>key===id)))throw Error('Check the homepage text, categories and banner products.');
  return content;
}
const cents=value=>/^\d+(?:\.\d{1,2})?$/.test(String(value))?Math.round(Number(value)*100):NaN;
function productFormPayload(form,data) {
  const one=name=>String(data.get(name)??'').trim();
  const sku=one('sku'),variantSku=one('variantSku');
  if(data.getAll('variantSku').length!==1||variantSku!==sku)throw Error('Each listing uses one variant with the same SKU as the product.');
  const price=one('variantPrice');
  if(!/^\d+(?:\.\d{1,2})?$/.test(price)||Number(price)<=0)throw Error('Enter a valid price.');
  const stock=Number(one('variantStock')),min=Number(one('variantMin'));
  if(!Number.isSafeInteger(stock)||stock<0||!Number.isSafeInteger(min)||min<1)throw Error('Enter valid stock and minimum quantity.');
  const image=one('variantImage')||one('image');
  if(!imageUrl(image))throw Error('Enter a valid HTTPS product image URL.');
  const fields={name:one('name'),variant_name:one('variantName'),brand:one('brand'),category_id:one('category'),
    description:one('description'),keywords:one('keywords'),status:one('status'),featured:data.has('featured'),
    image_url:image,r2_image_url:image,price_cents:Math.round(Number(price)*100),min_quantity:min};
  if(!fields.name||!fields.variant_name||!fields.brand||!categories.some(([id])=>id===fields.category_id))throw Error('Complete the product name, variant, brand and category.');
  return {sku,fields,stock};
}
let shoppingOwner='',shoppingLoading=false;
async function loadMemberShopping() {
  const owner=auth.account?.id;
  if(!owner||auth.recoveryOnly)return;
  const result=await authRequest('/api/shopping');
  if(auth.account?.id!==owner)return;
  state.cart=Object.fromEntries(result.cart.map(item=>[item.sku,item.quantity]));
  state.saved=result.saved;
  state.recentlyViewed=result.recent.map(sku=>({id:sku,sku}));
  rememberListings([...result.cart.map(item=>listingFromApi(item.product)),...(result.savedProducts??[]).map(listingFromApi),...(result.recentProducts??[]).map(listingFromApi)]);
  render();
}
async function syncShopping() {
  const owner=auth.account?.id??'';
  if(owner===shoppingOwner||shoppingLoading)return;
  const previous=shoppingOwner;
  shoppingOwner=owner;
  if(!owner){state.cart={};state.saved=[];state.recentlyViewed=[];save();render();return;}
  const guestCart=previous===''?Object.entries(state.cart).map(([sku,quantity])=>({sku,quantity})):[];
  state.cart={};state.saved=[];state.recentlyViewed=[];
  shoppingLoading=true;
  try{
    if(guestCart.length){
      const merged=await authRequest('/api/shopping',{action:'merge',items:guestCart});
      if(merged.skipped?.length)message(merged.skipped.length+' basket item(s) changed or became unavailable. Review your basket.');
    }
    await loadMemberShopping();
  }catch(error){message(error.message);}
  finally{shoppingLoading=false;render();}
}
async function setShoppingCart(sku,quantity) {
  if(auth.account&&!auth.recoveryOnly){
    await authRequest('/api/shopping',{action:'cart',sku,quantity});
    await loadMemberShopping();
    return;
  }
  if(quantity){
    const live=listingFromApi((await catalogRequest('/api/products/'+encodeURIComponent(sku))).product);
    rememberListings([live]);
  }
  const error=setCart(sku,quantity);
  if(error)throw Error(error);
}
function storefrontKey(path,params) { return path+'?'+params.toString(); }
function rememberListings(rows) {
  for(const product of rows) {
    const index=state.products.findIndex(row=>row.id===product.id);
    if(index<0)state.products.push(product);else state.products[index]=product;
  }
}
function ensureStorefront(path,params) {
  const key=storefrontKey(path,params);
  if(storefront.key===key||pendingStorefront===key)return;
  pendingStorefront=key;
  const [section,id]=path.replace(/^\//,'').split('/');
  (async()=>{
    const [categoryResult,publicConfig]=await Promise.all([catalogRequest('/api/categories'),catalogRequest('/api/config')]);
    const categoryRows=categoryResult.categories;
    categories.splice(0,categories.length,...categoryRows.map(row=>[row.id,row.name,row.icon,row.color]));
    if(publicConfig.homepage)state.settings.homepage=publicConfig.homepage;
    const delivery=publicConfig.delivery?.find(row=>row.country_code==='SG');
    if(delivery){state.settings.shipping=delivery.shipping_cents;state.settings.threshold=delivery.free_threshold_cents;}
    let data;
    if(section==='product') {
      const result=await catalogRequest('/api/products/'+encodeURIComponent(id));
      data={product:listingFromApi(result.product)};
      rememberListings([data.product]);
      const related=await catalogRequest(catalogQuery(new URLSearchParams('size=30'),data.product.category));
      data.related=related.products.map(listingFromApi).filter(row=>row.id!==data.product.id).slice(0,4);
      rememberListings(data.related);
    } else if(section==='categories') data={};
    else if(section==='cart'||section==='offers'){
      const offers=await catalogRequest('/api/offers');
      state.coupons=offers.offers.map(row=>({code:row.code,type:row.kind,amount:row.amount,min:row.minimum_cents,active:true}));
      data={};
    }
    else if(section==='' ) {
      const result=await catalogRequest('/api/products?size=30');
      data={products:result.products.map(listingFromApi),config:publicConfig};
      const missingHero=(publicConfig.homepage?.heroProductIds??[]).filter(sku=>!data.products.some(row=>row.id===sku)).slice(0,3);
      const hero=await Promise.allSettled(missingHero.map(sku=>catalogRequest('/api/products/'+encodeURIComponent(sku)).then(result=>listingFromApi(result.product))));
      data.products.push(...hero.filter(result=>result.status==='fulfilled').map(result=>result.value));
      rememberListings(data.products);
    } else {
      const category=section==='category'?id:'';
      const brandsQuery=new URLSearchParams();
      if(params.get('q'))brandsQuery.set('q',params.get('q'));
      if(category)brandsQuery.set('category',category);
      const [result,facets]=await Promise.all([catalogRequest(catalogQuery(params,category)),catalogRequest('/api/brands?'+brandsQuery)]);
      data={products:result.products.map(listingFromApi),pagination:result.pagination,brands:facets.brands};
      rememberListings(data.products);
    }
    if(pendingStorefront===key){storefront={key,data,error:null};pendingStorefront='';render();}
  })().catch(error=>{if(pendingStorefront===key){storefront={key,data:null,error};pendingStorefront='';render();}});
}
const storefrontFailure=error=>'<section class="empty" role="alert"><h2>Catalog unavailable</h2><p>'+e(error?.message||'Please retry.')+'</p><button class="btn outline" data-retry-catalog>Retry</button></section>';

function refreshReceipts() {
  clearTimeout(receiptTimer);
  const now=Date.now();
  const {changed,nextDue}=syncAutoReceipts(now);
  if(Number.isFinite(nextDue)) receiptTimer=setTimeout(render,Math.min(nextDue-now,2_147_483_647));
  return changed;
}

function openImage(button) {
  const image=button.querySelector('img');
  if(!image) return;
  imageDialog.querySelector('h2').textContent=button.dataset.imagePreview;
  const preview=imageDialog.querySelector('img');
  preview.hidden=false;
  preview.dataset.imageFallbacks=image.dataset.imageFallbacks;
  imageDialog.querySelector('.photo-error').hidden=true;
  preview.src=image.getAttribute('src');
  imageDialog.showModal();
}
document.addEventListener('error',event=>{
  const img=event.target;
  if(!img.matches?.('img[data-image-fallbacks]')) return;
  const fallbacks=JSON.parse(img.dataset.imageFallbacks);
  const next=imageUrl(fallbacks.shift());
  img.dataset.imageFallbacks=JSON.stringify(fallbacks);
  if(next) {img.src=next;return;}
  const container=img.parentElement;
  container.querySelector('.photo-error').hidden=false;
  if(container.matches('button')) {img.remove();container.disabled=true;}
  else img.hidden=true;
},true);

const previousAdminRoutes=new Map([
  ['/admin/reports','/admin'],['/admin/orders','/admin'],['/admin/media','/admin/products'],['/admin/inventory','/admin/products']
]);
const privateBuyerRoutes=new Set(['/orders','/saved','/recently-viewed','/confirmation']);
function route() {
  const hash=location.hash.slice(1) || (location.pathname==='/'||location.pathname.endsWith('.html')?'/':location.pathname);
  const [path,qs='']=hash.split('?');
  let destination=previousAdminRoutes.get(path)??path;
  let params=Object.fromEntries(new URLSearchParams(qs));
  const section='/'+path.replace(/^\//,'').split('/')[0];
  if(section==='/tracking') {
    destination='/orders';
    params={view:'receive',...(params.id?{id:params.id}:{})};
  } else if(privateBuyerRoutes.has(section)) {
    destination=section;
  }
  if(!state.account&&!auth.loading&&privateBuyerRoutes.has(destination)) {
    params={next:href(destination,params).slice(1)};
    destination='/account';
  }
  if(destination!==path) history.replaceState(history.state,'',href(destination,params));
  return {path:destination,params:new URLSearchParams(params)};
}
function returnAfterSignIn(next) {
  const [path,qs='']=next.split('?');
  if(path==='checkout'||path==='/checkout') return navigate('/checkout');
  if(path==='/admin'&&auth.isAdmin)return navigate('/admin');
  if(privateBuyerRoutes.has(path)) return navigate(path,Object.fromEntries(new URLSearchParams(qs)));
  navigate('/account');
}
function render({scroll=false}={}) {
  state.account=auth.account&&!auth.recoveryOnly?auth.account:null;
  refreshReceipts();
  const {path,params}=route();
  const [key='',id='',object='']=path.replace(/^\//,'').split('/');
  const admin=key==='admin';
  if(admin&&auth.isAdmin&&!adminProductsLoaded&&!adminProductsLoading&&!adminProductsError)loadAdminProducts();
  const productView=key==='product'?path+'?'+(params.get('sku')??''):'';
  const publicCatalog=['','shop','search','categories','category','product','cart','offers'].includes(key);
  if(publicCatalog&&path!==lastPath&&storefront.key===storefrontKey(path,params))storefront={key:'',data:null,error:null};
  if(publicCatalog)ensureStorefront(path,params);
  const remote=publicCatalog&&storefront.key===storefrontKey(path,params)?storefront:null;
  if(key!=='cart') repurchaseResult=null;
  let body='';
  if(publicCatalog&&!remote) body='<section class="empty" role="status"><h2>Loading catalog…</h2></section>';
  else if(publicCatalog&&remote.error) body=storefrontFailure(remote.error);
  else if((auth.loading&&privateBuyerRoutes.has(path))||(shoppingLoading&&['cart','saved','recently-viewed'].includes(key)))body='<section class="panel narrow"><h1>My account</h1><p role="status">Loading your shopping list…</p></section>';
  else if(admin) body=auth.isAdmin&&!auth.recoveryOnly?
    !adminProductsLoaded?'<main class="wrap" id="main"><section class="panel narrow"><h1>Products</h1><p role="status">'+e(adminProductsError||'Loading shared product data…')+'</p>'+(adminProductsError?'<button class="btn outline" data-retry-admin>Retry</button>':'')+'</section></main>':adminPage(id,object,params):adminGate();
  else {
    switch(key) {
      case '': body=home(remote.data.products);break;
      case 'shop': case 'search': body=catalog(path,params,'',remote.data);break;
      case 'categories': body=allCategories();break;
      case 'category': body=categories.some(c=>c[0]===id)?catalog(path,params,id,remote.data):missing();break;
      case 'product': {
        const product=remote.data.product;
        if(isNewProductView(product,productView,lastProductView)){
          rememberProduct(product,params.get('sku'));
          if(auth.account&&!auth.recoveryOnly)authRequest('/api/shopping',{action:'recent',sku:product.sku}).then(loadMemberShopping).catch(()=>{});
        }
        lastProductView=productView;
        body=detail(product,params,remote.data.related);break;
      }
      case 'cart': body=cart(repurchaseResult);break;
      case 'checkout': {
        if(auth.account&&deliveryAddresses()===null)queueMicrotask(loadAddresses);
        body=checkout(deliveryAddresses());break;
      }
      case 'account': body=authForms(params)??(account(params)+'<div class="buyer-dashboard account-settings">'+profilePanel()+addressesPanel()+passwordPanel()+'</div>');break;
      case 'orders': body=orders(params);break;
      case 'recently-viewed': body=recentlyViewedPage();break;
      case 'confirmation':
        if(auth.account&&!auth.recoveryOnly)queueMicrotask(()=>refreshCheckoutReturn(params.get('session_id')));
        body=confirmation(params);break;
      case 'saved': body=savedPage();break;
      case 'offers': body=offers();break;
      default: body=info(key);
    }
  }
  document.body.classList.toggle('admin-body',admin);
  app.innerHTML=admin?body:shopFrame(body,params.get('q')??'');
  const heading=app.querySelector('h1');
  document.title=(key&&heading?heading.textContent+' · ':'')+'CP Value Mart';
  if(scroll&&path!==lastPath) window.scrollTo(0,0);
  lastPath=path;
  if(!productView)lastProductView='';
}
function navigate(path,params={}) {
  const destination=href(path,params);
  if(location.hash===destination) render();
  else location.hash=destination;
}
function message(text) {
  const inline=modal.open&&modal.querySelector('.modal-status');
  if(inline) {inline.textContent=text;inline.hidden=false;return;}
  toast.textContent=text; toast.hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{toast.hidden=true;},3200);
}
function showModal(content) {
  modal.innerHTML='<button class="modal-close" type="button" data-close aria-label="Close dialog">×</button>'+content+'<p class="notice modal-status" role="status" hidden></p>';
  modal.showModal();
  modal.querySelector('input, select, [data-confirm-reset], [data-confirm-import]')?.focus();
}
const cleanParams = obj => Object.fromEntries(Object.entries(obj).filter(([,v])=>typeof v==='string'&&v.trim()).map(([k,v])=>[k,v.trim()]));
let csvToImport, repurchaseResult;

document.addEventListener('submit', async event=>{
  const form=event.target;
  if(!form.id) return;
  event.preventDefault();
  const data=new FormData(form), f=Object.fromEntries(data);
  if(form.id.startsWith('auth-')) {
    const button=event.submitter??form.querySelector('button');if(button?.disabled)return;
    if(button)button.disabled=true;
    const status=form.querySelector('[data-auth-status]');if(status){status.hidden=false;status.textContent='Please wait…';}
    try {
      const result=await submitAuth(form,f);
      if(form.id==='auth-login')returnAfterSignIn(form.dataset.next??'');
      else if(form.id==='auth-password'){navigate('/account');message(result.message);}
      else if(form.id==='auth-verify'){navigate('/account');message(result.recoveryOnly?'Choose your new password.':'Email verified. Sign in with your password.');}
      else if(form.id==='auth-profile')message('Name saved.');
      else if(form.id==='auth-address')message('Address saved.');
      else if(status){status.hidden=false;status.textContent=result.message;}
      if(['auth-signup','auth-recover','auth-resend'].includes(form.id))form.querySelectorAll('input[type=password]').forEach(input=>input.value='');
    } catch(error){if(status?.isConnected){status.hidden=false;status.textContent=error.message;}else message(error.message);}
    finally {if(button?.isConnected)button.disabled=false;}
    return;
  }
  if(location.hash.startsWith('#/admin')) {try{await authRequest('/api/admin/access');}catch(error){await refreshSession();message(error.message);return;}}

  let error;
  switch(form.id) {
    case 'search-form': {
      const q=f.q.trim();
      navigate(q?'/search':'/shop',q?{q}:{});
      break;
    }
    case 'catalog-filters': case 'admin-filter':
      navigate(form.dataset.path,cleanParams(f)); break;
    case 'revenue-period-form':
      error=revenueDateError(f.from,f.to);
      if(!error) navigate('/admin/revenue',{range:'custom',from:f.from,to:f.to,metric:f.metric});
      break;
    case 'add-to-cart':
      try{await setShoppingCart(form.dataset.sku,(state.cart[form.dataset.sku]||0)+Number(f.qty));render();message('Added to your basket.');}
      catch(problem){error=problem.message;}break;
    case 'coupon-form': {
      const code=f.code.trim().toUpperCase();
      const active=state.coupons.find(c=>c.code===code&&c.active);
      if(code&&!active) {error='This coupon is unavailable.';break;}
      if(code&&!totals(undefined,code).valid) {error='The basket does not meet the coupon minimum.';break;}
      state.coupon=code;save();render();message(code?'Coupon applied.':'Coupon cleared.');break;
    }
    case 'account-form':
      error='Use the secure sign-in form.';break;
    case 'checkout-form': {
      const button=event.submitter??form.querySelector('button');if(button)button.disabled=true;
      const status=form.querySelector('[data-checkout-status]');if(status){status.hidden=false;status.textContent='Creating secure Stripe test checkout…';}
      try{const result=await authRequest('/api/checkout/session',{addressId:String(f.addressId),coupon:state.coupon||''});
        if(!result.testMode||!result.checkoutUrl.startsWith('https://checkout.stripe.com/'))throw Error('Test checkout could not be verified.');
        location.assign(result.checkoutUrl);return;
      }catch(problem){error=problem.message;if(status){status.hidden=false;status.textContent=error;}if(button)button.disabled=false;}
      break;
    }
    case 'contact-form':
      form.reset();
      document.getElementById('contact-status').textContent='Demo enquiry submitted. This preview does not send email.';
      break;
    case 'buyer-review-form':
      error=saveBuyerReview(form.dataset.order,form.dataset.sku,Number(f.rating),f.comment);
      if(!error) {modal.close();render();message('Rating submitted.');} break;
    case 'product-editor':
      try{const payload=productFormPayload(form,data);const existing=form.dataset.id?findProduct(form.dataset.id):null;
        await writeAdminProduct(payload.sku,existing?.version??0,payload.fields,payload.stock);
        navigate('/admin/products');message('Product saved.');}
      catch(problem){error=problem.message;}break;
    case 'order-editor': {
      const order=state.orders.find(row=>row.id===form.dataset.order),shipItem=event.submitter?.name==='ship-item';
      if(!order?.backendId){error='Order not found.';break;}
      try{await authRequest('/api/admin/orders',{orderId:order.backendId,version:order.version,status:shipItem?'Shipped':String(data.get('status')),tracking:String(data.get('tracking')??'').trim()});
        adminProductsLoaded=false;await loadAdminProducts();message(shipItem?'Item shipped.':'Fulfilment saved.');}
      catch(problem){error=problem.message;}break;
    }
    case 'coupon-editor':
      try{const code=String(data.get('code')??'').trim().toUpperCase(),kind=String(data.get('type')??''),number=Number(data.get('amount'));
        const amount=kind==='fixed'?cents(data.get('amount')):kind==='percent'?number:0,minimum=cents(data.get('min'));
        if(!/^[A-Z0-9_-]{1,40}$/.test(code)||!['percent','fixed','shipping'].includes(kind)||!Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(minimum)||minimum<0)throw Error('Check the coupon code and amount.');
        const result=await authRequest('/api/admin/config',{action:'coupon',version:couponVersions.get(code)??0,code,kind,amount,minimum,active:data.has('active')});
        couponVersions.set(code,result.coupon.version);adminProductsLoaded=false;modal.close();await loadAdminProducts();message('Coupon saved.');}
      catch(problem){error=problem.message;}break;
    case 'stock-editor': {
      const row=getVariant(form.dataset.sku);
      if(!row) {error='Product no longer exists.';break;}
      try{await writeAdminProduct(row.product.sku,row.product.version,{},Number(f.stock));modal.close();render();message('Stock updated.');}
      catch(problem){error=problem.message;}break;
    }
    case 'homepage-form':
      try{const result=await authRequest('/api/admin/config',{action:'homepage',version:homepageVersion,content:homepagePayload(data)});
        homepageVersion=result.homepage.version;state.settings.homepage=result.homepage.content;render();message('Homepage saved.');}
      catch(problem){error=problem.message;}break;
    case 'settings-form':
      try{const shipping=cents(data.get('shipping')),threshold=cents(data.get('threshold'));
        if(!Number.isSafeInteger(shipping)||!Number.isSafeInteger(threshold))throw Error('Enter valid delivery amounts.');
        const result=await authRequest('/api/admin/config',{action:'delivery',version:deliveryVersion,shipping,threshold});
        deliveryVersion=result.delivery.version;state.settings.shipping=shipping;state.settings.threshold=threshold;render();message('Delivery settings saved.');}
      catch(problem){error=problem.message;}break;
    case 'bulk-form':
      message(bulkUpdate(data));render();break;
  }
  if(error) message(error);
});
document.addEventListener('click', async event=>{
  const button=event.target.closest('button');
  if(!button) return;
  const data=button.dataset;
  if('authRetry'in data){await refreshSession();return;}
  if('retryAdmin'in data){adminProductsError='';loadAdminProducts();return;}
  if('retryCatalog'in data){storefront={key:'',data:null,error:null};pendingStorefront='';render();return;}
  if('defaultAddress'in data){if(button.disabled)return;button.disabled=true;try{await authRequest('/api/addresses/'+data.defaultAddress,{action:'default'});await loadAddresses();message('Default delivery address saved.');}catch(error){button.disabled=false;message(error.message);}return;}
  if('deleteAddress'in data){try{await authRequest('/api/addresses/'+data.deleteAddress,{action:'delete'});await loadAddresses();}catch(error){message(error.message);}return;}
  if(location.hash.startsWith('#/admin')){try{await authRequest('/api/admin/access');}catch(error){await refreshSession();message(error.message);return;}}
  if('imagePreview' in data) openImage(button);
  else if('closeImage' in data) imageDialog.close();
  else if('save' in data) {
    const saved=state.saved.includes(data.save);
    if(auth.account&&!auth.recoveryOnly){try{await authRequest('/api/shopping',{action:saved?'unsave':'save',sku:data.save});await loadMemberShopping();}catch(error){return message(error.message);}}
    else{state.saved=saved?state.saved.filter(id=>id!==data.save):[...state.saved,data.save];save();}render();
    [...document.querySelectorAll('[data-save]')].find(b=>b.dataset.save===data.save)?.focus({preventScroll:true});
    message(saved?'Removed from saved items.':'Added to saved items.');
  } else if('quickAdd' in data) {
    const sku=data.quickAdd;
    let live;
    try{live=listingFromApi((await catalogRequest('/api/products/'+encodeURIComponent(sku))).product);rememberListings([live]);}
    catch(error){return message(error.message);}
    const row=getVariant(sku);
    if(!row) return message('This item is unavailable.');
    const current=state.cart[sku]??0;
    const added=Math.max(1,row.variant.min-current);
    try{await setShoppingCart(sku,current+added);}catch(error){return message(error.message);}
    render();
    [...document.querySelectorAll('[data-quick-add]')].find(b=>b.dataset.quickAdd===sku)?.focus({preventScroll:true});
    message('Added '+added+' × '+row.product.name+' ('+row.variant.name+') to your basket.');
  } else if('repurchase' in data) {
    const result=repurchaseOrder(data.repurchase);
    if(result.error) return message(result.error);
    repurchaseResult=result;
    navigate('/cart');
    if(result.added&&!result.skipped.length) message('Previous items added to your basket.');
  } else if('quantity' in data) {
    const sku=data.quantity;
    const qty=state.cart[sku]+Number(data.delta);
    try{await setShoppingCart(sku,qty);render();}catch(error){message(error.message);}
  } else if('remove' in data) {try{await setShoppingCart(data.remove,0);render();}catch(error){message(error.message);}}
  else if('signOut' in data) {try{await signOut();navigate('/account');message('Signed out.');}catch(error){message(error.message);}}
  else if('receiveOrder' in data) {
    const error=confirmBuyerReceipt(data.receiveOrder);
    if(error) message(error);
    else {navigate('/orders',{view:'receive',stage:'delivered'});message('Order received. You can rate it in To Rate.');}
  } else if('rateOrder' in data) {
    const item=reviewItem(data.rateOrder,data.rateSku);
    if(item) showModal(buyerReviewDialog(data.rateOrder,item));
    else message('This item is unavailable for review.');
  } else if('copy' in data) {
    const code=data.copy;
    try {await navigator.clipboard.writeText(code);message('Copied '+code+'.');}
    catch {message('Use coupon code '+code+' in your basket.');}
  } else if('addVariant' in data) {const error=extraVariant();if(error)message(error);}
  else if('removeVariant' in data) {
    button.closest('.variant-fields')?.remove();
    document.querySelectorAll('#variant-fields .variant-fields').forEach((fieldset,i)=>{
      fieldset.querySelector('legend').textContent='Variant '+(i+1);
      fieldset.querySelector('[data-remove-variant]').setAttribute('aria-label','Delete variant '+(i+1));
    });
  }
  else if('stock' in data) {
    const row=getVariant(data.stock);
    if(row) showModal(stockEditor(data.stock,row.variant,row.product));
  } else if('editCoupon' in data) showModal(couponEditor(data.editCoupon));
  else if(data.export==='revenue') {
    exportRevenueReport(route().params);
    message('Revenue report generated.');
  } else if('export' in data) exportData(data.export);
  else if('reset' in data) showModal('<div class="form-stack"><h2 id="dialog-title">Reset preview?</h2><p>This clears the changes and demo orders made in this browser.</p><button class="btn primary" data-confirm-reset>Reset demo data</button></div>');
  else if('confirmReset' in data) {reset();modal.close();render();message('Preview reset.');}
  else if('confirmImport' in data) {
    try {
      const count=importProducts(csvToImport);modal.close();render();message(count+' products imported.');
    } catch(error) {modal.close();message(error.message);}
    csvToImport=undefined;
  } else if('close' in data) {csvToImport=undefined;modal.close();}
});
let editorPreviewTimer;
document.addEventListener('input',event=>{
  const {form,name}=event.target;
  if(form?.id!=='product-editor'||!['image','variantImage'].includes(name)) return;
  clearTimeout(editorPreviewTimer);
  editorPreviewTimer=setTimeout(()=>{if(form.isConnected) refreshEditorPhotos(form);},250);
});
document.addEventListener('change',async event=>{
  const input=event.target;
  if(location.hash.startsWith('#/admin')){try{await authRequest('/api/admin/access');}catch(error){await refreshSession();message(error.message);return;}}
  if(input.dataset.inline) {
    const row=getVariant(input.dataset.sku);
    if(!row){message('Product no longer exists.');return;}
    const kind=input.dataset.inline, value=input.value.trim();let fields;
    if(kind==='name'&&value&&value.length<=60)fields={variant_name:value};
    else if(kind==='price'&&/^\d+(?:\.\d{1,2})?$/.test(value)&&Number(value)>0)fields={price_cents:Math.round(Number(value)*100)};
    else if(kind==='min'&&/^[1-9]\d*$/.test(value))fields={min_quantity:Number(value)};
    if(!fields){message('Enter a valid product value.');input.value=input.defaultValue;return;}
    try{await writeAdminProduct(row.product.sku,row.product.version,fields);render();message('Product updated.');}
    catch(error){message(error.message);input.value=input.defaultValue;}return;
  }
  if(input.dataset.inlineStatus) {
    const product=findProduct(input.dataset.inlineStatus);
    if(!product||!['Published','Draft','Archived'].includes(input.value)){message('Choose a valid status.');render();return;}
    try{await writeAdminProduct(product.sku,product.version,{status:input.value});render();message('Status updated.');}
    catch(error){message(error.message);render();}return;
  }
  if(input.id==='category-filter') {
    const q=route().params.get('q');
    location.hash=(input.value==='#/shop'&&q?href('/shop',{q}):input.value);
  }
  if(input.form?.id==='catalog-filters'&&input.tagName==='SELECT') input.form.requestSubmit();
  if(input.id==='select-all') {
    for(const checkbox of document.querySelectorAll('#bulk-form input[name=id]')) checkbox.checked=input.checked;
  }
  if(input.id==='import-csv'&&input.files?.[0]) {
    const file=input.files[0];
    input.value='';
    if(file.size>2*1024*1024) {message('Use a CSV below 2 MB.');return;}
    try {
      csvToImport=await file.text();
      showModal('<div class="form-stack"><h2 id="dialog-title">Import products?</h2><p>'+e(file.name)+' will add products or update matching SKUs.</p><button type="button" class="btn primary" data-confirm-import>Import CSV</button></div>');
    } catch {message('The CSV could not be read.');}
  }
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){storefront={key:'',data:null,error:null};adminProductsLoaded=false;refreshSession().then(()=>{if(auth.account)loadMemberShopping().catch(()=>{});});render();}
});
window.addEventListener('pageshow',event=>{if(event.persisted){storefront={key:'',data:null,error:null};refreshSession().then(()=>{if(auth.account)loadMemberShopping().catch(()=>{});});render();}});
window.addEventListener('hashchange',()=>{if(imageDialog.open)imageDialog.close();if(modal.open)modal.close();render({scroll:true});});
window.addEventListener('storage',event=>{
  if(event.key==='cvm-preview-13m-20261118-v1'&&event.newValue) {
    try {Object.assign(state,JSON.parse(event.newValue),{account:null});render();} catch {}
  }
});
setAuthListener(()=>{if(auth.account?.id!==shoppingOwner)adminProductsLoaded=false;if(auth.account?.id&&auth.account.id!==ordersOwner&&!ordersLoading)loadOrders();render();syncShopping();});
render();
refreshSession();
