import {auth,authForms,adminGate,profilePanel,addressesPanel,loadAddresses,authRequest,submitAuth,signOut,refreshSession,setAuthListener} from './auth.js';
import {state,save,reset,escape as e,findProduct,getVariant,setCart,totals,makeOrder,matching,logSearch,categories,imageUrl,rememberProduct,confirmBuyerReceipt,reviewItem,saveBuyerReview,syncAutoReceipts,repurchaseOrder} from './store.js';
import {href,home,shopFrame,catalog,detail,cart,checkout,account,orders,recentlyViewedPage,buyerReviewDialog,confirmation,allCategories,savedPage,offers,info,missing} from './shop.js';
import {adminPage,extraVariant,stockEditor,couponEditor,storeCoupon,storeProduct,saveFulfilment,saveSettings,saveHomepage,exportData,exportRevenueReport,revenueDateError,importProducts,bulkUpdate,refreshEditorPhotos,updateInlineProduct,updateInlineStatus} from './admin.js';

const app=document.getElementById('app'), toast=document.getElementById('toast'), modal=document.getElementById('dialog');
const imageDialog=document.getElementById('image-dialog');
let lastPath='', lastProductView='', toastTimer, receiptTimer;

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
  const productView=key==='product'?path+'?'+(params.get('sku')??''):'';
  if(key!=='cart') repurchaseResult=null;
  let body='';
  if(auth.loading&&privateBuyerRoutes.has(path))body='<section class="panel narrow"><h1>My account</h1><p role="status">Checking your session…</p></section>';
  else if(admin) body=auth.isAdmin&&!auth.recoveryOnly?adminPage(id,object,params):adminGate();
  else {
    switch(key) {
      case '': body=home();break;
      case 'shop': case 'search': body=catalog(path,params);break;
      case 'categories': body=allCategories();break;
      case 'category': body=categories.some(c=>c[0]===id)?catalog(path,params,id):missing();break;
      case 'product': {
        const product=findProduct(id);
        if(productView!==lastProductView) rememberProduct(product,params.get('sku'));
        body=detail(product,params);break;
      }
      case 'cart': body=cart(repurchaseResult);break;
      case 'checkout': body=checkout();break;
      case 'account': body=authForms(params)??(params.get('mode')==='addresses'?addressesPanel():account(params)+profilePanel());break;
      case 'orders': body=orders(params);break;
      case 'recently-viewed': body=recentlyViewedPage();break;
      case 'confirmation': body=confirmation(params);break;
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
  lastProductView=productView;
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
    const status=form.querySelector('#auth-status');if(status){status.hidden=false;status.textContent='Please wait…';}
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
      logSearch(q,matching(q).length);
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
      error=setCart(form.dataset.sku,(state.cart[form.dataset.sku]||0)+Number(f.qty));
      if(!error) {render();message('Added to your basket.');} break;
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
      if(!f.name.trim()||!f.address.trim()) {error='Enter a name and sample delivery address.';break;}
      const result=makeOrder({...f,name:f.name.trim(),address:f.address.trim()});
      if(result.error) error=result.error; else navigate('/confirmation',{id:result.order.id});
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
      error=storeProduct(form,data);
      if(!error) {navigate('/admin/products');message('Product saved.');} break;
    case 'order-editor': {
      const shipItem=event.submitter?.name==='ship-item';
      error=saveFulfilment(form,data,shipItem);
      if(!error) {render();message(shipItem?'Item shipped.':'Fulfilment saved.');} break;
    }
    case 'coupon-editor':
      error=storeCoupon(form,data);
      if(!error) {modal.close();render();message('Coupon saved.');} break;
    case 'stock-editor': {
      const row=getVariant(form.dataset.sku);
      if(!row) {error='Variant no longer exists.';break;}
      row.variant.stock=Number(f.stock); save(); modal.close(); render();message('Stock updated.');break;
    }
    case 'homepage-form':
      error=saveHomepage(data);
      if(!error) {render();message('Homepage saved.');} break;
    case 'settings-form':
      saveSettings(data);render();message('Delivery settings saved.');break;
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
  if('defaultAddress'in data){if(button.disabled)return;button.disabled=true;try{await authRequest('/api/addresses/'+data.defaultAddress,{action:'default'});await loadAddresses();message('Default delivery address saved.');}catch(error){button.disabled=false;message(error.message);}return;}
  if('deleteAddress'in data){try{await authRequest('/api/addresses/'+data.deleteAddress,{action:'delete'});await loadAddresses();}catch(error){message(error.message);}return;}
  if(location.hash.startsWith('#/admin')){try{await authRequest('/api/admin/access');}catch(error){await refreshSession();message(error.message);return;}}
  if('imagePreview' in data) openImage(button);
  else if('closeImage' in data) imageDialog.close();
  else if('save' in data) {
    const saved=state.saved.includes(data.save);
    state.saved=saved?state.saved.filter(id=>id!==data.save):[...state.saved,data.save];save();render();
    [...document.querySelectorAll('[data-save]')].find(b=>b.dataset.save===data.save)?.focus({preventScroll:true});
    message(saved?'Removed from saved items.':'Added to saved items.');
  } else if('quickAdd' in data) {
    const sku=data.quickAdd;
    const row=getVariant(sku);
    if(!row) return message('This item is unavailable.');
    const current=state.cart[sku]??0;
    const added=Math.max(1,row.variant.min-current);
    const error=setCart(sku,current+added);
    if(error) return message(error);
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
    const error=setCart(sku,qty);
    if(error) message(error); else render();
  } else if('remove' in data) {setCart(data.remove,0);render();}
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
    const error=updateInlineProduct(input.dataset.inline,input.dataset.sku,input.value);
    if(error) {message(error);input.value=input.defaultValue;return;}
    render();message('Product updated.');return;
  }
  if(input.dataset.inlineStatus) {
    const error=updateInlineStatus(input.dataset.inlineStatus,input.value);
    if(error) {message(error);render();return;}
    render();message('Status updated.');return;
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
  if(document.visibilityState==='visible'){refreshSession();if(refreshReceipts())render();}
});
window.addEventListener('pageshow',event=>{if(event.persisted)refreshSession();if(refreshReceipts())render();});
window.addEventListener('hashchange',()=>{if(imageDialog.open)imageDialog.close();if(modal.open)modal.close();render({scroll:true});});
window.addEventListener('storage',event=>{
  if(event.key==='cvm-preview-13m-20261118-v1'&&event.newValue) {
    try {Object.assign(state,JSON.parse(event.newValue),{account:null});render();} catch {}
  }
});
setAuthListener(()=>render());
render();
refreshSession();
