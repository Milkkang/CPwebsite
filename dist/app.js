import {productFileCsv} from './import-file.js';
import {auth,authForms,adminGate,profilePanel,passwordPanel,addressesPanel,loadAddresses,deliveryAddresses,authRequest,submitAuth,signOut,refreshSession,setAuthListener} from './auth.js';
import {state,save,reset,escape as e,findProduct,getVariant,totals,matching,logSearch,categories,imageUrl,rememberProduct,confirmBuyerReceipt,reviewItem,saveBuyerReview,syncAutoReceipts,repurchaseOrder} from './store.js';
import {href,home,shopFrame,catalog,detail,cart,checkout,account,orders,recentlyViewedPage,buyerReviewDialog,confirmation,allCategories,savedPage,offers,info,missing} from './shop.js';
import {adminPage,canShipOrder,canDeliverOrder,extraVariant,stockEditor,couponEditor,storeCoupon,storeProduct,saveFulfilment,saveSettings,saveHomepage,exportData,exportRevenueReport,revenueDateError,importProducts,prepareProductImport,bulkUpdate,refreshEditorPhotos,updateInlineProduct,updateInlineStatus} from './admin.js';
import {listingFromApi,catalogRequest,catalogQuery,isNewProductView} from './catalog-client.js';

const app=document.getElementById('app'), toast=document.getElementById('toast'), modal=document.getElementById('dialog');
const imageDialog=document.getElementById('image-dialog');
let lastPath='', lastProductView='', toastTimer, receiptTimer;
let renderedAdminGate=null;
let storefront={key:'',data:null,error:null}, pendingStorefront='';
let storefrontDeliveryLoaded=false;
let adminProductsLoaded=false,adminProductsLoading=false,adminProductsError='';
let homepageVersion=0,deliveryVersion=0,couponVersions=new Map();
let ordersOwner='';
let returnSession='',checkoutReturn,ordersRequest;
let checkoutAccess;
function loadCheckoutAccess(owner){
 const check={owner,available:null};
 checkoutAccess=check;
 authRequest('/api/checkout/session').then(data=>{check.available=data.available===true;check.livePayment=data.livePayment===true;check.pending=data.pending===true;})
  .catch(()=>{check.available=false;})
  .finally(()=>{if(checkoutAccess===check&&route().path==='/checkout')render();});
}
const trafficPending=new Set(),trafficRecorded=new Set();
const trafficDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function trackTraffic(event){
 const key='cvm-traffic-'+event+'-'+trafficDay();
 if(trafficRecorded.has(key))return;
 try{if(sessionStorage.getItem(key))return;}catch{}
 if(trafficPending.has(key))return;
 trafficPending.add(key);
 fetch('/api/traffic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event}),keepalive:true})
  .then(response=>{if(response.ok){trafficRecorded.add(key);try{sessionStorage.setItem(key,'1');}catch{}}})
  .catch(()=>{}).finally(()=>trafficPending.delete(key));
}
function mapOrder(row){return {id:row.number,backendId:row.id,version:row.version,createdAt:row.createdAt,date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(row.createdAt)),email:row.email??auth.account?.email??'',name:row.name??auth.account?.name??'',deliveryName:row.address?.name??'',address:row.address?.line??'',postal:row.address?.postal??'',status:row.fulfilmentStatus,tracking:row.tracking,
 items:row.items.map(item=>({productId:item.sku,sku:item.sku,name:item.name,option:item.option,price:item.price,qty:item.qty})),
 totals:{subtotal:row.subtotal,shipping:row.shipping,discount:row.discount,total:row.total},paymentStatus:row.paymentStatus,paidAt:row.paidAt,livePayment:row.livePayment===true};}
async function loadOrders(){
 const owner=auth.account?.id;
 if(!owner||auth.recoveryOnly||ordersRequest?.owner===owner)return;
 const request={owner};ordersRequest=request;
 try{
  const result=await authRequest('/api/orders');
  if(ordersRequest===request&&auth.account?.id===owner){
   state.orders=result.orders.map(mapOrder);ordersOwner=owner;
  }
 }catch(error){if(ordersRequest===request)message(error.message);}
 finally{if(ordersRequest===request){ordersRequest=undefined;render();}}
}
async function refreshCheckoutReturn(sessionId){
 const owner=auth.account?.id;
 if(!owner||!sessionId||checkoutReturn)return;
 const result={status:'checking'};
 checkoutReturn=result;
 const active=()=>checkoutReturn===result&&auth.account?.id===owner;
 try{
  for(let attempt=0;attempt<15&&active();attempt++){
   const data=await authRequest('/api/checkout/status?'+new URLSearchParams({session_id:sessionId}));
   if(!active())return;
   if(data.paymentStatus!=='pending'){
    Object.assign(result,{status:data.paymentStatus,orderNumber:data.orderNumber,livePayment:data.livePayment===true});
    await Promise.allSettled([loadMemberShopping(),loadOrders()]);
    return;
   }
   await new Promise(resolve=>setTimeout(resolve,2000));
  }
  result.status='pending';
 }catch(error){result.status=error.code==='CHECKOUT_NOT_FOUND'?'unavailable':'error';}
 finally{if(active())render();}
}
async function loadAdminProducts() {
  if(!auth.isAdmin||adminProductsLoading)return;
  const owner=auth.account?.id;
  adminProductsLoading=true;adminProductsError='';
  try{
    const [result,config,orderResult,emailResult,searchResult,categoryResult,trafficResult]=await Promise.all([authRequest('/api/admin/products'),authRequest('/api/admin/config'),authRequest('/api/admin/orders'),authRequest('/api/admin/email-jobs'),authRequest('/api/admin/search'),authRequest('/api/admin/categories'),authRequest('/api/admin/traffic').then(data=>({data})).catch(error=>({error:error.message}))]);
    if(auth.account?.id!==owner||!auth.isAdmin)return;
    state.products=result.products.map(row=>listingFromApi(row,{admin:true}));
    state.adminCategories=categoryResult.categories;
    categories.splice(0,categories.length,...categoryResult.categories.map(row=>[row.id,row.name,row.icon??'',row.color??'sage']));
    state.searches=Object.fromEntries(searchResult.searches.map(row=>[row.term,{count:row.searches,misses:row.misses}]));
    state.traffic=trafficResult.data?.traffic??null;
    state.trafficError=trafficResult.error??'';
    state.settings.homepage=config.homepage?.content??{};
    homepageVersion=config.homepage?.version??0;
    state.settings.shipping=config.delivery?.shipping_cents??0;
    state.settings.threshold=config.delivery?.free_threshold_cents??0;
    deliveryVersion=config.delivery?.version??0;
    state.coupons=config.coupons.map(row=>({code:row.code,type:row.kind,amount:row.amount,min:row.minimum_cents,active:row.active}));
    couponVersions=new Map(config.coupons.map(row=>[row.code,row.version]));
    state.adminOrders=orderResult.orders.map(row=>({...mapOrder(row),emailJobs:emailResult.jobs.filter(job=>job.orderId===row.id)}));
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
let shoppingOwner,shoppingLoading=false;
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
  shoppingOwner=owner;
  if(!owner){state.cart={};state.saved=[];state.recentlyViewed=[];save();render();return;}
  // Guest baskets are not supported. Clear any legacy browser basket before
  // loading the authenticated member basket so refreshes can never merge it.
  state.cart={};state.saved=[];state.recentlyViewed=[];
  save();
  shoppingLoading=true;
  try{
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
  throw Error('Sign in to add products to your basket.');
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
    storefrontDeliveryLoaded=Boolean(delivery);
    if(delivery){state.settings.shipping=delivery.shipping_cents;state.settings.threshold=delivery.free_threshold_cents;}
    else if(['cart','checkout','delivery'].includes(section))throw Error('Delivery rates are currently unavailable. Please retry.');
    let data;
    if(section==='product') {
      const result=await catalogRequest('/api/products/'+encodeURIComponent(id));
      data={product:listingFromApi(result.product)};
      rememberListings([data.product]);
      const related=await catalogRequest(catalogQuery(new URLSearchParams('size=30'),data.product.category));
      data.related=related.products.map(listingFromApi).filter(row=>row.id!==data.product.id).slice(0,4);
      rememberListings(data.related);
    } else if(section==='categories'||section==='delivery') data={};
    else if(['cart','checkout','offers'].includes(section)){
      const offers=await catalogRequest('/api/offers');
      state.coupons=offers.offers.map(row=>({code:row.code,type:row.kind,amount:row.amount,min:row.minimum_cents,active:true}));
      if(state.coupon&&!state.coupons.some(coupon=>coupon.code===state.coupon)){state.coupon='';save();}
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
  ['/admin/reports','/admin'],['/admin/media','/admin/products'],['/admin/inventory','/admin/products']
]);
const privateBuyerRoutes=new Set(['/cart','/orders','/saved','/recently-viewed','/confirmation']);
function route() {
  const hash=location.hash.slice(1) || (location.pathname==='/'||location.pathname.endsWith('.html')?'/':location.pathname);
  const [path,qs='']=hash.split('?');
  if(path==='/confirmation'){
    const sessionId=new URLSearchParams(qs).get('session_id');
    if(sessionId){
      if(/^cs_(?:test|live)_[A-Za-z0-9_]{1,200}$/.test(sessionId)&&returnSession!==sessionId){
        returnSession=sessionId;checkoutReturn=undefined;
      }
      history.replaceState(null,'','#/confirmation');
      return route();
    }
  }else if(path!=='/account'||!new URLSearchParams(qs).get('next')?.startsWith('/confirmation')){
    returnSession='';checkoutReturn=undefined;
  }
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
  if(/^\/product\/[A-Za-z0-9_-]{1,100}$/.test(path))return navigate(path,Object.fromEntries(new URLSearchParams(qs)));
  if(privateBuyerRoutes.has(path)) return navigate(path,Object.fromEntries(new URLSearchParams(qs)));
  navigate('/account');
}
function render({scroll=false}={}) {
  state.account=auth.account&&!auth.recoveryOnly?auth.account:null;
  refreshReceipts();
  const {path,params}=route();
  const [key='',id='',object='']=path.replace(/^\//,'').split('/');
  const admin=key==='admin';
  const adminRecovery=admin&&params.get('mode')==='recover';
  const showAdminGate=admin&&(!auth.isAdmin||auth.recoveryOnly||adminRecovery);
  if(admin&&!adminRecovery&&auth.isAdmin&&!adminProductsLoaded&&!adminProductsLoading&&!adminProductsError)loadAdminProducts();
  const productView=key==='product'?path+'?'+(params.get('sku')??''):'';
  const publicCatalog=['','shop','search','categories','category','product','cart','checkout','delivery','offers'].includes(key);
  if(publicCatalog&&path!==lastPath&&storefront.key===storefrontKey(path,params))storefront={key:'',data:null,error:null};
  if(publicCatalog)ensureStorefront(path,params);
  const remote=publicCatalog&&storefront.key===storefrontKey(path,params)?storefront:null;
  if(key!=='cart') repurchaseResult=null;
  if(key!=='checkout'||checkoutAccess?.owner!==state.account?.id)checkoutAccess=undefined;
  let body='';
  if(publicCatalog&&!remote) body='<section class="empty" role="status"><h2>Loading catalog…</h2></section>';
  else if(publicCatalog&&remote.error) body=storefrontFailure(remote.error);
  else if((auth.loading&&privateBuyerRoutes.has(path))||(shoppingLoading&&['cart','checkout','saved','recently-viewed'].includes(key)))body='<section class="panel narrow"><h1>My account</h1><p role="status">Loading your shopping list…</p></section>';
  else if(showAdminGate) body=adminGate(params);
  else if(admin) body=
    !adminProductsLoaded?'<main class="wrap" id="main"><section class="panel narrow"><h1>Products</h1><p role="status">'+e(adminProductsError||'Loading shared product data…')+'</p>'+(adminProductsError?'<button class="btn outline" data-retry-admin>Retry</button>':'')+'</section></main>':
      adminPage(id,object,params,id==='settings'?'<div class="narrow account-settings">'+passwordPanel()+'</div>':'');
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
        if(state.account&&!checkoutAccess)loadCheckoutAccess(state.account.id);
        if(checkoutAccess?.available&&deliveryAddresses()===null)queueMicrotask(loadAddresses);
        body=checkout(deliveryAddresses(),checkoutAccess?.available,{livePayment:checkoutAccess?.livePayment,pending:checkoutAccess?.pending});break;
      }
      case 'account': body=authForms(params)??(account(params)+'<div class="buyer-dashboard account-settings">'+profilePanel()+addressesPanel()+passwordPanel()+'</div>');break;
      case 'orders': body=orders(params);break;
      case 'recently-viewed': body=recentlyViewedPage();break;
      case 'confirmation':
        if(auth.account&&!auth.recoveryOnly&&returnSession)queueMicrotask(()=>refreshCheckoutReturn(returnSession));
        body=confirmation(params,returnSession?(checkoutReturn??{status:'checking'}):undefined);break;
      case 'saved': body=savedPage();break;
      case 'offers': body=offers();break;
      default: body=info(key);
    }
  }
  document.body.classList.toggle('admin-body',admin);
  const gate=showAdminGate?{route:location.hash, account:auth.account?.id, body}:null;
  // Keep the form mounted when a background refresh leaves the route and session unchanged.
  if(!gate||gate.route!==renderedAdminGate?.route||gate.account!==renderedAdminGate.account||gate.body!==renderedAdminGate.body)
    app.innerHTML=admin?body:shopFrame(body,params.get('q')??'',{showAdminLink:key!=='account',showDeliveryThreshold:storefrontDeliveryLoaded});
  renderedAdminGate=gate;
  if(!admin)trackTraffic('visit');
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

function updateOrderSelection(input) {
  const selectPage=app.querySelector('[data-select-page-orders]');
  const checkboxes=[...app.querySelectorAll('[data-select-order]')];
  if(input===selectPage)for(const checkbox of checkboxes)checkbox.checked=input.checked;
  const count=checkboxes.filter(checkbox=>checkbox.checked).length;
  selectPage.checked=count===checkboxes.length;
  selectPage.indeterminate=count>0&&count<checkboxes.length;
  app.querySelector('[data-order-selection]').textContent=count+' selected';
  app.querySelector('[data-open-bulk-order]').disabled=count===0;
}

document.addEventListener('submit', async event=>{
  const form=event.target;
  if(!form.id) return;
  event.preventDefault();
  const data=new FormData(form), f=Object.fromEntries(data);
  if(form.id.startsWith('auth-')) {
    const admin=location.hash.startsWith('#/admin');
    const button=event.submitter??form.querySelector('button');if(button?.disabled)return;
    if(button)button.disabled=true;
    const status=form.querySelector('[data-auth-status]');if(status){status.hidden=false;status.textContent='Please wait…';}
    try {
      const result=await submitAuth(form,f);
      if(form.id==='auth-login'&&!admin)returnAfterSignIn(form.dataset.next??'');
      else if(form.id==='auth-password'){navigate(admin?'/admin':'/account');message(result.message);}
      else if(form.id==='auth-verify'){navigate('/account');message(result.recoveryOnly?'Choose your new password.':'Email verified. Sign in with your password.');}
      else if(form.id==='auth-profile')message('Account details saved.');
      else if(form.id==='auth-address')message('Address saved.');
      else if(status){status.hidden=false;status.textContent=result.message;}
      if(['auth-signup','auth-recover','auth-resend'].includes(form.id))form.querySelectorAll('input[type=password]').forEach(input=>input.value='');
    } catch(error){if(status?.isConnected){status.hidden=false;status.textContent=error.message;}else message(error.message);}
    finally {if(button?.isConnected)button.disabled=false;}
    return;
  }
  if(form.id==='bulk-order-form'){
    const shipping=form.dataset.action==='ship';
    const owner=auth.account?.id;
    const button=form.querySelector('button[type=submit]');
    if(button.disabled)return;
    const orders=[...form.querySelectorAll('[data-order-version]')].map(input=>({
      orderId:input.name,version:Number(input.dataset.orderVersion),...(shipping?{tracking:input.value.trim()}:{})
    }));
    if(shipping&&orders.some(order=>!order.tracking)){message('Enter a tracking number for each order.');return;}
    button.disabled=true;
    try{
      const result=await authRequest('/api/admin/orders/bulk-'+(shipping?'ship':'deliver'),{orders});
      if(owner!==auth.account?.id||!auth.isAdmin)return;
      if(modal.contains(form))modal.close();
      adminProductsLoaded=false;
      await loadAdminProducts();
      const count=shipping?result.shipped:result.delivered;
      if(owner===auth.account?.id&&auth.isAdmin)message(count+(count===1?' order':' orders')+(shipping?' shipped.':' marked as delivered.'));
    }catch(problem){
      if(owner!==auth.account?.id||!auth.isAdmin)return;
      if(problem.code==='VERSION_CONFLICT'){
        adminProductsLoaded=false;
        await loadAdminProducts();
      }
      if(owner!==auth.account?.id||!auth.isAdmin||!modal.contains(form))return;
      if(problem.code==='VERSION_CONFLICT')modal.close();
      message(problem.message);
    }finally{button.disabled=false;}
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
    case 'sales-year-form':
      navigate('/admin/revenue',{...Object.fromEntries(route().params),year:f.year});break;
    case 'add-to-cart':
      try{await setShoppingCart(form.dataset.sku,(state.cart[form.dataset.sku]||0)+Number(f.qty));trackTraffic('cart');render();message('Added to your basket.');}
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
    case 'checkout-pending-form': {
      const button=event.submitter;if(!button||button.disabled)break;
      button.disabled=true;
      try{
        const result=await authRequest('/api/checkout/manage',{action:button.value});
        if(result.checkoutUrl?.startsWith('https://checkout.stripe.com/')){location.assign(result.checkoutUrl);return;}
        if(result.cancelled){checkoutAccess=undefined;render();message('Checkout cancelled. Your basket is ready.');return;}
      }catch(problem){error=problem.message;}
      button.disabled=false;break;
    }
    case 'checkout-form': {
      const button=event.submitter??form.querySelector('button');if(button)button.disabled=true;
      const status=form.querySelector('[data-checkout-status]');if(status){status.hidden=false;status.textContent='Opening Stripe checkout…';}
      try{const result=await authRequest('/api/checkout/session',{addressId:String(f.addressId),coupon:state.coupon||''});
        if(typeof result.checkoutUrl!=='string'||!result.checkoutUrl.startsWith('https://checkout.stripe.com/'))throw Error('Checkout could not be verified.');
        location.assign(result.checkoutUrl);return;
      }catch(problem){error=problem.message;if(problem.code==='CHECKOUT_PENDING'){checkoutAccess=undefined;render();}
        if(status){status.hidden=false;status.textContent=error;}if(button)button.disabled=false;}
      break;
    }
    case 'buyer-review-form':
      error=saveBuyerReview(form.dataset.order,form.dataset.sku,Number(f.rating),f.comment);
      if(!error) {modal.close();render();message('Rating submitted.');} break;
    case 'product-editor':
      try{const payload=productFormPayload(form,data);const existing=form.dataset.id?findProduct(form.dataset.id):null;
        await writeAdminProduct(payload.sku,existing?.version??0,payload.fields,payload.stock);
        navigate('/admin/products',Object.fromEntries(route().params));message('Product saved.');}
      catch(problem){error=problem.message;}break;
    case 'order-editor': {
      const order=state.adminOrders.find(row=>row.id===form.dataset.order),shipItem=event.submitter?.name==='ship-item';
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
  if('signOut' in data){
    if(button.disabled)return;
    const admin=location.hash.startsWith('#/admin');
    button.disabled=true;
    try{await signOut();navigate(admin?'/admin':'/account');message('Signed out.');}
    catch(error){button.disabled=false;message(error.message);}
    return;
  }
  if('retryAdmin'in data){adminProductsError='';loadAdminProducts();return;}
  if('retryCatalog'in data){storefront={key:'',data:null,error:null};pendingStorefront='';render();return;}
  if('defaultAddress'in data){if(button.disabled)return;button.disabled=true;try{await authRequest('/api/addresses/'+data.defaultAddress,{action:'default'});await loadAddresses();message('Default delivery address saved.');}catch(error){button.disabled=false;message(error.message);}return;}
  if('deleteAddress'in data){try{await authRequest('/api/addresses/'+data.deleteAddress,{action:'delete'});await loadAddresses();}catch(error){message(error.message);}return;}
  if('openBulkOrder' in data){
    const shipping=data.openBulkOrder==='ship';
    const selected=new Set([...app.querySelectorAll('[data-select-order]:checked')].map(input=>input.value));
    const eligible=shipping?canShipOrder:canDeliverOrder;
    const orders=state.adminOrders.filter(order=>selected.has(order.backendId)&&eligible(order));
    if(!orders.length)return;
    const fields=orders.map(order=>{
      const field=' name="'+e(order.backendId)+'" data-order-version="'+e(order.version)+'"';
      return shipping?'<label>'+e(order.id)+' tracking number<input'+field+
        ' value="'+e(order.tracking)+'" maxlength="120" autocomplete="off" required></label>':
        '<li>'+e(order.id)+'<input type="hidden"'+field+'></li>';
    }).join('');
    const action=shipping?'Mark as shipped':'Mark as delivered';
    showModal('<form id="bulk-order-form" data-action="'+(shipping?'ship':'deliver')+'" class="form-stack"><h2 id="dialog-title">'+
      action+'</h2>'+(shipping?fields:'<ul>'+fields+'</ul>')+'<button type="submit" class="btn primary">'+action+'</button></form>');
    if(!shipping)modal.querySelector('button[type=submit]').focus();
    return;
  }
  if(location.hash.startsWith('#/admin')){try{await authRequest('/api/admin/access');}catch(error){await refreshSession();message(error.message);return;}}
  if('orderGroups' in data){for(const group of document.querySelectorAll('.order-date-group'))group.open=data.orderGroups==='expand';}
  else if('imagePreview' in data) openImage(button);
  else if('closeImage' in data) imageDialog.close();
  else if('save' in data) {
    const saved=state.saved.includes(data.save);
    if(auth.account&&!auth.recoveryOnly){try{await authRequest('/api/shopping',{action:saved?'unsave':'save',sku:data.save});await loadMemberShopping();}catch(error){return message(error.message);}}
    else{return navigate('/account',{next:location.hash.slice(1)||'/saved'});}render();
    [...document.querySelectorAll('[data-save]')].find(b=>b.dataset.save===data.save)?.focus({preventScroll:true});
    message(saved?'Removed from saved items.':'Added to saved items.');
  } else if('quickAdd' in data) {
    if(!auth.account||auth.recoveryOnly){navigate('/account',{next:'/cart'});message('Sign in to add products to your basket.');return;}
    const sku=data.quickAdd;
    let live;
    try{live=listingFromApi((await catalogRequest('/api/products/'+encodeURIComponent(sku))).product);rememberListings([live]);}
    catch(error){return message(error.message);}
    const row=getVariant(sku);
    if(!row) return message('This item is unavailable.');
    const current=state.cart[sku]??0;
    const added=Math.max(1,row.variant.min-current);
    try{await setShoppingCart(sku,current+added);}catch(error){return message(error.message);}
    trackTraffic('cart');render();
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
  else if('resendEmail' in data) {
    if(button.disabled)return;button.disabled=true;
    try{await authRequest('/api/admin/email-jobs',{action:'resend',jobId:data.resendEmail});adminProductsLoaded=false;await loadAdminProducts();message('Email queued for delivery.');}
    catch(error){button.disabled=false;message(error.message);}return;
  }
  else if('receiveOrder' in data) {
    const order=state.orders.find(row=>row.id===data.receiveOrder);
    if(!order?.backendId)return;
    button.disabled=true;
    try{await authRequest('/api/orders/receipt',{orderId:order.backendId,version:order.version});await loadOrders();navigate('/orders',{view:'receive',stage:'delivered'});message('Receipt confirmed.');}
    catch(error){button.disabled=false;message(error.message);}
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
  } else if('orderAction' in data) {
    const order=state.adminOrders.find(row=>row.id===data.orderId);
    if(!order?.backendId)return;
    const restock=Boolean(document.getElementById('refund-restock')?.checked);
    if(!window.confirm(data.orderAction==='refund'?'Refund this '+(order.livePayment?'':'simulated ')+'payment and close the order'+(restock?' with stock returned?':' without returning stock?'):'Cancel this unpaid order?'))return;
    button.disabled=true;
    try{await authRequest('/api/admin/order-actions',{orderId:order.backendId,version:order.version,action:data.orderAction,restock});adminProductsLoaded=false;await loadAdminProducts();message('Order updated.');}
    catch(error){message(error.message);button.disabled=false;}
  } else if('editCoupon' in data) showModal(couponEditor(data.editCoupon));
  else if(data.export==='revenue') {
    exportRevenueReport(route().params);
    message('Revenue report generated.');
  } else if('export' in data) exportData(data.export);
  else if('reset' in data) showModal('<div class="form-stack"><h2 id="dialog-title">Clear browser data?</h2><p>This clears the shopping data stored in this browser.</p><button class="btn primary" data-confirm-reset>Clear browser data</button></div>');
  else if('confirmReset' in data) {reset();modal.close();render();message('Browser data cleared.');}
  else if('confirmImport' in data) {
    try {
      const products=prepareProductImport(csvToImport);
      const rows=products.map(p=>({sku:p.sku,version:state.products.find(old=>old.sku===p.sku)?.version??0,stock:p.variants[0].stock,
       fields:{name:p.name,variant_name:p.variants[0].name,brand:p.brand,category_id:p.category,description:p.description,keywords:p.keywords,status:p.status,featured:p.featured,image_url:p.image,original_image_url:p.original,r2_image_url:p.r2,price_cents:p.variants[0].price,min_quantity:p.variants[0].min}}));
      button.disabled=true;
      const result=await authRequest('/api/admin/import',{rows});
      modal.close();adminProductsLoaded=false;await loadAdminProducts();message(result.count+' products imported.');
    } catch(error) {button.disabled=false;message(error.message);}
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
  if('selectOrder' in input.dataset||'selectPageOrders' in input.dataset){updateOrderSelection(input);return;}
  if(input.form?.id==='checkout-form'&&input.name==='addressId'){
    for(const card of input.form.querySelectorAll('[data-checkout-address]'))card.hidden=card.dataset.checkoutAddress!==input.value;
    return;
  }
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
  if(input.form?.id==='admin-filter'&&['size','group','sort'].includes(input.name))input.form.requestSubmit();
  if(input.form?.id==='sales-year-form'&&input.name==='year')input.form.requestSubmit();
  if(input.id==='select-all') {
    for(const checkbox of document.querySelectorAll('#bulk-form input[name=id]')) checkbox.checked=input.checked;
  }
  if(input.id==='import-csv'&&input.files?.[0]) {
    const file=input.files[0];
    input.value='';
    if(file.size>2*1024*1024) {message('Use a CSV below 2 MB.');return;}
    try {
      csvToImport=await productFileCsv(file);
      showModal('<div class="form-stack"><h2 id="dialog-title">Import products?</h2><p>'+e(file.name)+' will add products or update matching SKUs.</p><button type="button" class="btn primary" data-confirm-import>Import products</button></div>');
    } catch(error) {message(error.message||'The file could not be read.');}
  }
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){storefront={key:'',data:null,error:null};adminProductsLoaded=false;refreshSession().then(()=>{if(auth.account)loadMemberShopping().catch(()=>{});});render();}
});
window.addEventListener('pageshow',event=>{if(event.persisted){storefront={key:'',data:null,error:null};refreshSession().then(()=>{if(auth.account)loadMemberShopping().catch(()=>{});});render();}});
window.addEventListener('hashchange',()=>{if(imageDialog.open)imageDialog.close();if(modal.open)modal.close();render({scroll:true});});
let lastSignedInAccount;
setAuthListener(()=>{
 const owner=auth.recoveryOnly?undefined:auth.account?.id;
 if(owner!==lastSignedInAccount){
  if(lastSignedInAccount){returnSession='';checkoutReturn=undefined;}
  lastSignedInAccount=owner;
  state.orders=[];state.adminOrders=[];ordersOwner='';ordersRequest=undefined;
  adminProductsLoaded=false;adminProductsError='';
 }
 if(!auth.isAdmin||auth.recoveryOnly){state.adminOrders=[];adminProductsLoaded=false;}
 if(owner&&owner!==ordersOwner&&ordersRequest?.owner!==owner)loadOrders();
 render();syncShopping();
});
render();
refreshSession();
