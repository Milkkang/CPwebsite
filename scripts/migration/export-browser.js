// Run in DevTools Console on https://cpvaluemart.com. Downloads business data only.
// Does not upload anything or include accounts, orders, addresses, carts or tokens.
(() => {
  const value = localStorage.getItem('cvm-preview-13m-20261118-v1');
  if (!value) throw new Error('No saved browser catalog; repository defaults are in use.');
  const state = JSON.parse(value);
  const fields = ['id','sku','name','brand','category','keywords','status','featured','description','image','original','r2'];
  const products = (state.products ?? []).map(p => ({
    ...Object.fromEntries(fields.map(k => [k,p[k]])),
    variants: (p.variants ?? []).map(v => Object.fromEntries(['sku','name','price','stock','min','image'].map(k=>[k,v[k]])))
  }));
  const data = { format: 'cpvaluemart-business-export-v1', products,
    settings: { shipping:state.settings?.shipping, threshold:state.settings?.threshold, homepage:state.settings?.homepage },
    coupons: (state.coupons ?? []).map(c=>Object.fromEntries(['code','type','amount','min','active'].map(k=>[k,c[k]]))) };
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href=url;link.download='cpvaluemart-business-export.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
})();
