import assert from 'node:assert/strict';
import {test} from 'node:test';
const storage = new Map();
globalThis.localStorage = {getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
const {state}=await import('../dist/store.js');
const {updateInlineProduct,updateInlineStatus,storeProduct,productEditor}=await import('../dist/admin.js');
const p=state.products[0], v=p.variants[0];
assert.equal(updateInlineProduct('name',v.sku,'Updated 250g'),undefined);
assert.ok(p.name.endsWith(' · Updated 250g'));
assert.equal(updateInlineProduct('price',v.sku,'5.25'),undefined);
assert.equal(v.price,525);
assert.equal(updateInlineProduct('min',v.sku,'4'),undefined);
assert.equal(v.min,4);
for(const [field,value] of [['name',''],['price','-1'],['price','2.555'],['min','0'],['min','1.5']]) assert.equal(typeof updateInlineProduct(field,v.sku,value),'string');
assert.equal(v.price,525); assert.equal(v.min,4);
assert.equal(updateInlineStatus(p.id,'Draft'),undefined);
assert.equal(p.status,'Draft');
const persisted=JSON.parse([...storage.values()][0]).products.find(row=>row.id===p.id);
assert.equal(persisted.variants[0].name,'Updated 250g');
assert.equal(persisted.variants[0].price,525);
assert.equal(persisted.variants[0].min,4);
assert.equal(persisted.status,'Draft');
function edit(image,variantImage) {
 const values=new FormData();
 for(const [key,value] of Object.entries({sku:p.sku,name:p.name,brand:p.brand,category:p.category,status:p.status,description:p.description,keywords:p.keywords,image,variantName:v.name,variantSku:v.sku,variantPrice:'5.25',variantStock:'100',variantMin:'4',variantImage})) values.set(key,value);
 return storeProduct({dataset:{id:p.id}},values);
}
assert.equal(edit('https://example.com/replacement.jpg',v.image??''),undefined);
let saved=state.products.find(row=>row.id===p.id);
assert.equal(saved.image,'https://example.com/replacement.jpg');
assert.equal(saved.r2,saved.image);
assert.equal(saved.variants[0].image,saved.image);
assert.equal(edit('https://example.com/listing.jpg','https://example.com/explicit-variant.jpg'),undefined);
saved=state.products.find(row=>row.id===p.id);
assert.equal(saved.image,'https://example.com/explicit-variant.jpg');
assert.ok(!productEditor(p.id).includes('Image references'));
assert.match(productEditor(p.id),/R2 image URL/);
assert.match(productEditor(p.id),/name="name"[^>]*maxlength="500"/);
assert.equal((productEditor('new').match(/<fieldset/g)??[]).length,1);
assert.ok(!productEditor('new').includes('data-add-variant'));
console.log('PASS: inline persistence and validation; R2 replacement; explicit variant override; editor fields');

const {saveHomepage,adminPage}=await import('../dist/admin.js');
const {home,allCategories}=await import('../dist/shop.js');
assert.match(home(),/Everyday essentials,/);
const homepage=new FormData();
for(const [key,value] of Object.entries({eyebrow:'CP test',title:'Hello <shop>\nSingapore',description:'New description',primaryLabel:'Browse',primaryPath:'/shop',secondaryLabel:'',secondaryPath:'/offers',categoryTitle:'Selected categories'})) homepage.set(key,value);
homepage.append('categoryId','oral-care');
assert.equal(saveHomepage(homepage),undefined);
assert.match(home(),/Hello &lt;shop&gt;<br>Singapore/);
assert.match(home(),/Selected categories/);
assert.equal((home().match(/class="cat-card"/g)??[]).length,1);
assert.equal((allCategories().match(/class="cat-card"/g)??[]).length,11);
assert.ok(!home().includes('View offers'));
assert.match(adminPage('homepage',undefined,new URLSearchParams()),/Save homepage/);
assert.equal(JSON.parse([...storage.values()][0]).settings.homepage.title,'Hello <shop>\nSingapore');
homepage.delete('categoryId'); assert.equal(saveHomepage(homepage),undefined);
assert.ok(!home().includes('Selected categories'));
homepage.set('primaryPath','javascript:alert(1)');
assert.equal(typeof saveHomepage(homepage),'string');
assert.equal(state.settings.homepage.primaryPath,'/shop');
console.log('PASS: homepage settings, escaping, category visibility, persistence and destination validation');

const {catalog,catalogPagination}=await import('../dist/shop.js');
const params=new URLSearchParams();
assert.equal(catalogPagination(params,678).size,30);
assert.equal((catalog('/shop',params).match(/class="product-card"/g)??[]).length,30);
params.set('size','50'); params.set('page','2');
assert.deepEqual(catalogPagination(params,678),{size:50,pages:14,page:2,start:50});
assert.equal((catalog('/shop',params).match(/class="product-card"/g)??[]).length,50);
params.set('size','100'); params.set('page','999');
assert.equal(catalogPagination(params,678).page,7);
params.set('size','invalid'); params.set('page','-2');
assert.equal(catalogPagination(params,0).page,1);
assert.equal(catalogPagination(params,0).size,30);
console.log('PASS: catalog page sizes, rendered counts and boundary clamping');
assert.equal((home().match(/class="product-card"/g)??[]).length,10);

test('an open editor keeps its version until the admin reloads and reviews the latest product',async t=>{
 const initial={sku:'EDITOR-1',name:'Editor fixture',variant_name:'One',brand:'Fixture',category_id:'acceptance',
  description:'Original description',status:'Draft',image_url:'https://example.invalid/editor.jpg',
  price_cents:1000,stock:10,min_quantity:1,version:1};
 let latest=initial,writeUnavailable=false,reloadUnavailable=false;
 let sessionResponse,writeResponse;
 const location=new URL('https://cpvaluemart.com/#/admin/products/EDITOR-1?sort=stock');
 const events=new Map(),windowEvents=new Map(),toast={textContent:'',hidden:true},dialog={open:false};
 let account={id:'admin',email:'admin@example.invalid',name:'Admin'};
 const app={
  html:'',form:null,
  set innerHTML(html){
   this.html=html;
   if(this.form)this.form.isConnected=false;
   const editor=html.match(/<form id="product-editor"([^>]*)>/)?.[1];
   if(!editor){this.form=null;return;}
   const attribute=name=>editor.match(new RegExp(name+'="([^"]*)"'))?.[1];
   const inputs=['name','brand','sku','image','variantName','variantSku','variantPrice','variantStock','variantMin'];
   const values=Object.fromEntries(inputs.map(name=>[name,html.match(new RegExp('<input name="'+name+'" value="([^"]*)"'))?.[1]]));
   values.category=html.match(/<select name="category">.*?<option value="([^"]+)" selected>/)?.[1];
   values.status=html.match(/<select name="status">.*?<option selected>([^<]+)<\/option>/)?.[1];
   values.description=html.match(/<textarea name="description"[^>]*>([^<]*)<\/textarea>/)?.[1];
   const status={hidden:true,textContent:''};
   const save={disabled:false};
   const reload={dataset:{reloadProduct:''},hidden:true,disabled:false,closest:()=>this.form};
   const selectors={'[data-product-status]':status,'[data-product-save]':save,'[data-reload-product]':reload};
   this.form={id:'product-editor',dataset:{id:attribute('data-id'),version:attribute('data-version')},isConnected:true,values,
    replaceWith(previous){this.isConnected=false;previous.isConnected=true;app.form=previous;},
    querySelector:selector=>html.includes(selector.slice(1,-1))?selectors[selector]??null:null};
  },
  get innerHTML(){return this.html;},
  querySelector:selector=>selector==='#product-editor'?app.form:null
 };
 const globals={location,history:{},document:{visibilityState:'visible',
  getElementById:id=>id==='app'?app:id==='toast'?toast:dialog,addEventListener:(type,fn)=>events.set(type,fn),body:{classList:{toggle(){}}}},
  window:{addEventListener:(type,fn)=>windowEvents.set(type,fn),scrollTo(){}},BroadcastChannel:undefined,
  FormData:class extends URLSearchParams {constructor(form){super(form.values);}}};
 for(const [name,value] of Object.entries(globals)){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,name);
  Object.defineProperty(globalThis,name,{value,configurable:true,writable:true});
  t.after(()=>descriptor?Object.defineProperty(globalThis,name,descriptor):delete globalThis[name]);
 }
 t.mock.timers.enable({apis:['setTimeout']});
 const writes=[];
 t.mock.method(globalThis,'fetch',async(path,options)=>{
  switch(path){
   case '/api/auth/session':return sessionResponse??Response.json({account,isAdmin:true});
   case '/api/admin/access':return Response.json({account,isAdmin:true});
   case '/api/orders':case '/api/admin/orders':return Response.json({orders:[]});
   case '/api/shopping':return Response.json({cart:[],saved:[],recent:[]});
   case '/api/admin/config':return Response.json({coupons:[]});
   case '/api/admin/email-jobs':return Response.json({jobs:[]});
   case '/api/admin/search':return Response.json({searches:[]});
   case '/api/admin/categories':return Response.json({categories:[{id:'acceptance',name:'Acceptance'}]});
   case '/api/admin/traffic':return Response.json({traffic:[]});
   case '/api/admin/products?sku=EDITOR-1':
    if(reloadUnavailable)return Response.json({error:{message:'Account service is temporarily unavailable.'}},{status:503});
    return Response.json({products:[latest]});
   case '/api/admin/products':{
    if(options.method==='GET')return Response.json({products:[latest]});
    const write=JSON.parse(options.body);writes.push(write);
    if(writeResponse)return writeResponse;
    if(write.version!==latest.version)return Response.json({error:{code:'VERSION_CONFLICT',message:'This product changed in another session. Reload it before saving.'}},{status:409});
    if(writeUnavailable)return Response.json({error:{code:'AUTH_UNAVAILABLE',message:'The product service is temporarily unavailable. Please try again.'}},{status:503});
    latest={...latest,...write.fields,stock:write.stock,version:latest.version+1};
    return Response.json({product:latest});
   }
   default:throw Error('Unexpected request '+path);
  }
 });
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const submit=()=>events.get('submit')({target:app.form,preventDefault(){}});
 const reload=()=>events.get('click')({target:{closest:()=>app.form.querySelector('[data-reload-product]')}});
 await import('../dist/app.js');
 await settle();
 assert.match(app.innerHTML,/Original description/);
 assert.match(app.innerHTML,/data-version="1"/);
 const staleForm=app.form;
 staleForm.values.description='My draft';
 latest={...initial,description:'Saved by another editor',stock:14,price_cents:1300,status:'Published',version:2};
 events.get('visibilitychange')();
 assert.equal(app.form,null);
 await settle();
 assert.equal(app.form,staleForm);
 let resolveWrite,resolveSession;
 writeResponse=new Promise(resolve=>{resolveWrite=resolve;});
 sessionResponse=new Promise(resolve=>{resolveSession=resolve;});
 const pendingSave=submit();
 events.get('visibilitychange')();
 assert.equal(app.form,null);
 resolveWrite(Response.json({error:{code:'VERSION_CONFLICT',message:'Reload the latest product.'}},{status:409}));
 await pendingSave;
 assert.equal(app.form,null);
 resolveSession(Response.json({account,isAdmin:true}));
 sessionResponse=null;writeResponse=null;
 await settle();
 assert.equal(app.form,staleForm);
 assert.equal(writes[0].version,1);
 assert.match(staleForm.querySelector('[data-product-status]').textContent,/changed.*reload/i);
 assert.equal(staleForm.values.description,'My draft');
 assert.equal(staleForm.querySelector('[data-reload-product]').hidden,false);
 assert.equal(staleForm.querySelector('[data-product-save]').disabled,true);
 assert.equal(toast.hidden,true);
 reloadUnavailable=true;
 await reload();
 assert.equal(app.form,staleForm);
 assert.match(staleForm.querySelector('[data-product-status]').textContent,/temporarily unavailable/);
 reloadUnavailable=false;
 await reload();
 assert.equal(location.hash,'#/admin/products/EDITOR-1?sort=stock');
 assert.match(app.innerHTML,/data-version="2"/);
 assert.match(app.innerHTML,/Saved by another editor/);
 assert.match(app.innerHTML,/name="variantStock"[^>]*value="14"/);
 assert.match(app.innerHTML,/name="variantPrice"[^>]*value="13.00"/);
 assert.match(app.innerHTML,/<option selected>Published<\/option>/);
 assert.match(app.form.querySelector('[data-product-status]').textContent,/review/i);
 app.form.values.description='Reviewed edit';
 writeUnavailable=true;
 await submit();
 assert.equal(writes.at(-1).version,2);
 assert.match(app.form.querySelector('[data-product-status]').textContent,/temporarily unavailable/);
 assert.equal(app.form.querySelector('[data-reload-product]').hidden,true);
 assert.equal(toast.hidden,true);
 writeUnavailable=false;
 await submit();
 assert.equal(latest.description,'Reviewed edit');
 assert.equal(latest.price_cents,1300);
 assert.equal(latest.stock,14);
 assert.equal(location.hash,'#/admin/products?sort=stock');
 assert.equal(toast.textContent,'Product saved.');
 windowEvents.get('hashchange')();
 const {listingFromApi}=await import('../dist/catalog-client.js');
 const previewKey='cvm-preview-13m-20261118-v1';
 localStorage.setItem(previewKey,JSON.stringify({
  products:[listingFromApi({...latest,available_quantity:2})],settings:{shipping:39},
  orders:[{id:'CVM-LEGACY-FIXTURE'}]
 }));
 windowEvents.get('storage')({key:previewKey});
 assert.doesNotMatch(localStorage.getItem(previewKey),/CVM-LEGACY-FIXTURE/);
 location.hash='#/admin/products/EDITOR-1?sort=stock';
 windowEvents.get('hashchange')();
 assert.equal(app.form.values.variantStock,'14');
 const formerEditor=app.form;
 formerEditor.values.description='Prior admin draft';
 account={id:'other-admin',email:'other-admin@example.invalid',name:'Other admin'};
 events.get('visibilitychange')();
 await settle();
 assert.notEqual(app.form,formerEditor);
 assert.equal(app.form.values.description,'Reviewed edit');
});
