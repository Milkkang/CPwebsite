import {cash,escape as e,findProduct,getVariant,categories,imageUrl} from './store.js';
import {productCategoryEditor,productDetailsEditor,productPriceEditor,refreshEditorPhotos} from './admin.js';

const listRoute=/^#\/admin\/products(?:\?|$)/;
const inputs=form=>[...form.querySelectorAll('input:not([type=hidden]), select, textarea')];
const valuesOf=form=>Object.fromEntries(inputs(form).map(input=>[input.name,input.type==='checkbox'?input.checked:input.value]));
const priceInCents=value=>{
  const text=String(value??'').trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text)||Number(text)<=0||Number(text)>99999)
    throw Error('Enter a price from S$0.01 to S$99,999 with at most two decimal places.');
  return Math.round(Number(text)*100);
};

function editPayload(mode,form,product) {
  const data=new FormData(form);
  const value=name=>String(data.get(name)??'').trim();
  const fields={};
  const text=(input,key,max,required=false)=>{
    const next=value(input);
    if((required&&!next)||next.length>max)throw Error('Check the text fields and try again.');
    fields[key]=next;
  };
  const integer=(input,min,max)=>{
    const next=value(input);
    if(!/^\d+$/.test(next)||Number(next)<min||Number(next)>max)
      throw Error('Enter a whole number between '+min+' and '+max+'.');
    return Number(next);
  };
  if(data.has('productName'))text('productName','name',500,true);
  if(data.has('variantName'))text('variantName','variant_name',60,true);
  if(data.has('price'))fields.price_cents=priceInCents(value('price'));
  if(data.has('min'))fields.min_quantity=integer('min',1,100000);
  if(mode==='category'){
    const category=value('category'),status=value('status');
    if(!categories.some(([id])=>id===category)||!['Published','Draft','Archived'].includes(status))
      throw Error('Choose a valid category and status.');
    Object.assign(fields,{category_id:category,status});
  }
  if(mode==='details'){
    text('brand','brand',70,true);
    text('description','description',1000);
    text('keywords','keywords',300);
    if(value('image')!==(product.image??'')){
      if(!imageUrl(value('image')))throw Error('Enter a valid HTTPS product image URL.');
      fields.image_url=fields.r2_image_url=value('image');
    }
  }
  return {fields,stock:data.has('stock')?integer('stock',product.reserved??0,1000000):undefined};
}

export function initProductEditing({app,account,render,writeProduct,writePrices,refreshProducts,fullPayload,message}) {
  const drawer=document.getElementById('product-drawer');
  const popover=document.getElementById('product-popover');
  const bulk=document.getElementById('product-price-dialog');
  let dialogsBound=false;
  let active,full,shownHash,shownAccount;
  const listPositions=new Map();
  const draftKey=(owner,id)=>'cvm-product-draft:'+owner+':'+id;
  const setStatus=(form,text)=>{
    const node=form.querySelector('.product-edit-status');
    node.textContent=text;
    node.hidden=!text;
  };
  const overlayHeading=(id,title)=>'<h2 id="'+id+'">'+title+'</h2>';
  function closeEdit(restore=true) {
    if(!active)return;
    const {trigger,form,container}=active;
    active=undefined;
    if(container===drawer||container===bulk)container.close();
    else if(container===popover)popover.hidePopover();
    else {
      form.reset();
      setStatus(form,'');
      container.hidden=true;
    }
    trigger.hidden=false;
    if(trigger.hasAttribute('aria-expanded'))trigger.setAttribute('aria-expanded','false');
    if(restore&&trigger.isConnected)trigger.focus({preventScroll:true});
  }
  function positionPopover() {
    if(active?.container!==popover)return;
    const rect=active.trigger.getBoundingClientRect();
    const left=Math.max(8,Math.min(rect.left,innerWidth-popover.offsetWidth-8));
    const top=rect.bottom+popover.offsetHeight+8<=innerHeight?rect.bottom+4:Math.max(8,rect.top-popover.offsetHeight-4);
    Object.assign(popover.style,{left:left+'px',top:top+'px'});
  }
  function openEdit(trigger) {
    if(active?.busy)return;
    if(!dialogsBound){
      for(const dialog of [drawer,bulk])dialog.addEventListener('cancel',event=>{
        event.preventDefault();
        if(!active?.busy)closeEdit();
      });
      dialogsBound=true;
    }
    if(active?.trigger===trigger){closeEdit();return;}
    closeEdit(false);
    const {editValue,expandProduct,productPopover,productDrawer}=trigger.dataset;
    let container,form,product,rows;
    if(editValue){
      form=container=trigger.nextElementSibling;
      product=getVariant(form.dataset.sku)?.product;
      trigger.hidden=true;
    }else if(expandProduct){
      product=findProduct(expandProduct);
      container=document.getElementById(trigger.getAttribute('aria-controls'));
      form=container.querySelector('form');
      trigger.setAttribute('aria-expanded','true');
    }else if(productPopover||productDrawer){
      product=findProduct(productPopover||productDrawer);
      if(!product)return;
      container=productPopover?popover:drawer;
      container.innerHTML=productPopover?overlayHeading('product-popover-title','Category and status')+productCategoryEditor(product):
        overlayHeading('product-drawer-title','Edit product details')+productDetailsEditor(product);
      form=container.querySelector('form');
    }else{
      rows=selectedProducts().map(input=>getVariant(input.value)).filter(Boolean)
        .map(({product,variant})=>({sku:product.sku,version:product.version,stock:variant.stock,price:variant.price}));
      if(!rows.length)return;
      container=bulk;
      container.innerHTML=productPriceEditor(rows);
      form=container.querySelector('form');
    }
    active={trigger,form,container,product,rows,owner:account()};
    if(container===popover){popover.showPopover();positionPopover();}
    else if(container===drawer)drawer.show();
    else if(container===bulk)bulk.showModal();
    else container.hidden=false;
    const field=inputs(form)[0];
    field?.focus();
    if(editValue&&field.type==='text')field.select();
  }
  const selectedProducts=()=>[...app.querySelectorAll('[data-select-product]:checked')];
  function syncSelection(selectPage) {
    const page=app.querySelector('[data-select-products]');
    if(!page)return;
    const checkboxes=[...app.querySelectorAll('[data-select-product]')];
    if(selectPage===page)for(const checkbox of checkboxes)checkbox.checked=page.checked;
    const count=selectedProducts().length;
    page.checked=count===checkboxes.length;
    page.indeterminate=count>0&&count<checkboxes.length;
    app.querySelector('[data-product-count]').textContent=count+' selected';
    app.querySelector('[data-bulk-prices]').disabled=!count;
  }
  function previewPrices(edit) {
    const {form,rows}=edit;
    const changes=rows.map(row=>({...row,newPrice:priceInCents(form.elements.namedItem(row.sku).value)}))
      .filter(row=>row.newPrice!==row.price);
    if(!changes.length)throw Error('Change at least one price to continue.');
    const preview=form.querySelector('[data-price-preview]');
    preview.innerHTML='<h3>Confirm '+changes.length+' price '+(changes.length===1?'change':'changes')+'</h3><ul>'+
      changes.map(row=>'<li><strong>'+e(row.sku)+'</strong> '+cash(row.price)+' → '+cash(row.newPrice)+'</li>').join('')+'</ul>';
    preview.hidden=false;
    edit.changes=changes;
    form.querySelector('.table-wrap').hidden=true;
    form.querySelector('[data-edit-prices]').hidden=false;
    form.querySelector('[type=submit], button.btn.primary').textContent='Confirm price changes';
  }

  function setBusy(edit,busy) {
    edit.busy=busy;
    for(const control of edit.form.querySelectorAll('button'))control.disabled=busy;
    for(const control of inputs(edit.form))control.disabled=busy;
  }
  async function submitEdit() {
    const edit=active;
    const mode=edit.form.dataset.productEdit;
    if(edit.busy||edit.stale)return;
    setStatus(edit.form,'');
    if(mode==='bulk'&&!edit.changes){
      try{previewPrices(edit);}catch(error){setStatus(edit.form,error.message);}
      return;
    }
    try{
      const payload=mode==='bulk'?null:editPayload(mode,edit.form,edit.product);
      setBusy(edit,true);
      if(mode==='bulk'){
        await writePrices(edit.changes.map(({sku,version,stock,newPrice})=>({sku,version,stock,fields:{price_cents:newPrice}})));
      }else await writeProduct(edit.product.sku,edit.product.version,payload.fields,payload.stock);
      if(active!==edit||account()!==edit.owner)return;
      if(mode==='bulk'){
        for(const input of selectedProducts())input.checked=false;
        syncSelection();
        try{await refreshProducts();}catch{
          if(active===edit){closeEdit();message('Prices saved. Reload products to see the new prices.');}
          return;
        }
      }
      if(active!==edit||!listRoute.test(location.hash))return;
      closeEdit(false);
      render({refreshProductEditor:true});
      const target=[...app.querySelectorAll('[data-edit-value], [data-expand-product], [data-product-popover], [data-product-drawer], [data-bulk-prices]')]
        .find(button=>button.getAttribute('aria-label')===edit.trigger.getAttribute('aria-label')&&
          Object.keys(edit.trigger.dataset).every(key=>button.dataset[key]===edit.trigger.dataset[key]));
      (target?.disabled?app.querySelector('[data-select-products]'):target)?.focus({preventScroll:true});
      message(mode==='bulk'?'Prices saved.':'Product updated.');
    }catch(error){
      if(active!==edit)return;
      if(error.code==='VERSION_CONFLICT'||error.code==='IMPORT_REJECTED'){
        edit.stale=true;
        setStatus(edit.form,'Products may have changed. Close this editor and reload the list before trying again.');
      }else setStatus(edit.form,error.message);
    }finally{
      if(active===edit){
        setBusy(edit,false);
        if(edit.stale)edit.form.querySelector('button.btn.primary').disabled=true;
      }
    }
  }

  function restoreDraft(form,owner) {
    const id=form.dataset.id||'new';
    const key=draftKey(owner,form.dataset.variantOf?'variant:'+form.dataset.variantOf:id);
    const version=findProduct(id)?.version??0;
    full={form,key,owner,version,original:valuesOf(form)};
    try{
      const draft=JSON.parse(sessionStorage.getItem(key));
      if(!draft?.values)return;
      full.version=draft.version;
      for(const input of inputs(form)){
        if(!Object.hasOwn(draft.values,input.name)||input.readOnly)continue;
        if(input.type==='checkbox')input.checked=draft.values[input.name]===true;
        else if(input.tagName!=='SELECT'||[...input.options].some(option=>option.value===draft.values[input.name]))input.value=draft.values[input.name];
      }
      draftNotice(version===draft.version?'Draft restored.':'The product changed since this draft was saved. Discard the draft to load the latest version.');
      refreshEditorPhotos(form);
    }catch{}
  }
  function draftNotice(text) {
    full.form.querySelector('[data-draft-status]').textContent=text;
    full.form.querySelector('[data-discard-draft]').hidden=!text;
  }
  function saveDraft() {
    const {form,key,version}=full;
    try{
      sessionStorage.setItem(key,JSON.stringify({version,values:valuesOf(form)}));
      draftNotice('Draft saved in this tab.');
    }catch{draftNotice('This browser could not save the draft.');}
  }
  function discardDraft(edit=full) {
    try{sessionStorage.removeItem(edit.key);}catch{}
  }
  async function submitFull() {
    const edit=full;
    if(!edit||edit.busy||edit.stale)return;
    const {form,owner}=edit;
    try{
      const payload=fullPayload(form,new FormData(form));
      setBusy(edit,true);
      const stock=form.dataset.id&&String(payload.stock)===edit.original.variantStock?undefined:payload.stock;
      await writeProduct(payload.sku,edit.version,payload.fields,stock,payload.variantOf);
      discardDraft(edit);
      if(full!==edit||account()!==owner)return;
      location.hash=form.dataset.back;
      message(payload.variantOf?'Variant saved.':'Product saved.');
    }catch(error){
      if(full!==edit)return;
      if(error.code==='VERSION_CONFLICT'){
        edit.stale=true;
        form.querySelector('[data-discard-draft]').hidden=false;
      }
      setStatus(form,error.message);
    }finally{
      if(full===edit){
        setBusy(edit,false);
        if(edit.stale)form.querySelector('button.btn.primary').disabled=true;
      }
    }
  }
  document.addEventListener('submit',event=>{
    if(event.target!==active?.form&&event.target!==full?.form)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if(event.target===full?.form)void submitFull();
    else void submitEdit();
  },true);
  document.addEventListener('input',event=>{
    if(full&&event.target.form===full.form)saveDraft();
  });
  document.addEventListener('change',event=>{
    if(event.target.matches('[data-select-product], [data-select-products]')){
      event.stopImmediatePropagation();
      syncSelection(event.target);
    }
  },true);
  document.addEventListener('click',async event=>{
    const button=event.target.closest('button');
    if(button?.matches('[data-edit-value], [data-expand-product], [data-product-popover], [data-product-drawer], [data-bulk-prices], [data-cancel-product], [data-edit-prices], [data-discard-draft]')){
      event.stopImmediatePropagation();
      if(button.hasAttribute('data-discard-draft')){
        if(!full||full.busy)return;
        const edit=full;
        setBusy(edit,true);
        try{
          await refreshProducts();
          if(full!==edit)return;
          discardDraft(edit);
          render({refreshProductEditor:true});
        }catch(error){
          if(full===edit){setBusy(edit,false);setStatus(edit.form,error.message);}
        }
      }else if(button.hasAttribute('data-cancel-product'))closeEdit();
      else if(button.hasAttribute('data-edit-prices')){
        active.changes=undefined;
        active.form.querySelector('[data-price-preview]').hidden=true;
        active.form.querySelector('.table-wrap').hidden=false;
        button.hidden=true;
        active.form.querySelector('button.btn.primary').textContent='Preview changes';
        setStatus(active.form,'');
        inputs(active.form)[0].focus();
      }else openEdit(button);
    }else if(active?.container===popover&&!active.busy&&!popover.contains(event.target))closeEdit(false);
  },true);
  document.addEventListener('keydown',event=>{
    if(!active)return;
    const {form,trigger,busy}=active;
    if(event.key==='Enter'&&!event.isComposing&&form.dataset.productEdit==='inline'&&event.target.form===form&&event.target.tagName==='INPUT'){
      event.preventDefault();
      if(!busy)form.requestSubmit();
    }
    if(event.key==='Escape'&&(form.contains(event.target)||event.target===trigger)){
      event.preventDefault();
      if(!busy)closeEdit();
    }
  });
  window.addEventListener('resize',positionPopover);
  window.addEventListener('scroll',positionPopover,true);

  return {
    isEditing:()=>Boolean(active||full),
    beforeRender(hash,owner,force){
      // Keep the focused editor through background renders, but clear it on navigation or sign-out.
      const same=shownHash===hash&&shownAccount===owner&&owner;
      if(same&&!force&&(active||full))return false;
      if(shownAccount!==owner)listPositions.clear();
      else if(listRoute.test(shownHash)){
        const table=app.querySelector('.product-table');
        if(table)listPositions.set(shownHash,{x:table.scrollLeft,y:scrollY,selected:new Set(selectedProducts().map(input=>input.value))});
      }
      closeEdit(false);
      full=undefined;
      shownHash=hash;
      shownAccount=owner;
      return true;
    },
    afterRender(){
      if(!shownAccount)return;
      const form=app.querySelector('#product-editor');
      if(form)restoreDraft(form,shownAccount);
      const position=listPositions.get(shownHash);
      const table=app.querySelector('.product-table');
      if(!position||!table)return;
      table.scrollLeft=position.x;
      for(const input of table.querySelectorAll('[data-select-product]'))input.checked=position.selected.has(input.value);
      syncSelection();
      requestAnimationFrame(()=>{if(table.isConnected)window.scrollTo(0,position.y);});
    }
  };
}
