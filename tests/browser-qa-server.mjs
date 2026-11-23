// Isolated UI fixture server. Never contacts production APIs or loads credentials.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('dist');
const category={id:'acceptance',name:'QA Products',published:true,sort_order:0,version:1};
const product={id:'QA-1',sku:'QA-1',name:'QA Product',variant_name:'Standard',brand:'QA Brand',category_id:category.id,description:'Synthetic acceptance fixture',keywords:'QA',status:'Published',featured:true,image_url:'/logo.png',original_image_url:'https://example.invalid/image.png',r2_image_url:'https://example.invalid/image.png',price_cents:250,stock:10,available_quantity:10,min_quantity:1,version:1};
const account={id:'11111111-1111-4111-8111-111111111111',email:'qa@example.invalid',name:'QA Fixture',verified:true};
let offline=false;const products=Array.from({length:Number(process.env.CP_QA_ROWS)||1},(_,i)=>({...product,id:'QA-'+(i+1),sku:'QA-'+(i+1),name:'QA Product '+(i+1)}));
const orders=[{id:'99999999-9999-4999-8999-999999999999',number:'CVM-QA',paymentStatus:'paid',fulfilmentStatus:'Processing',tracking:'',subtotal:500,shipping:0,discount:0,total:500,createdAt:new Date().toISOString(),paidAt:new Date().toISOString(),version:1,email:account.email,name:account.name,address:{name:'Synthetic',line:'Synthetic address',postal:'123456'},items:[{sku:'QA-1',name:'QA Product',option:'Standard',price:250,qty:2}]}];
const orderFixture=orders[0];
orders.splice(0,orders.length,...Array.from({length:Number(process.env.CP_QA_ROWS)||1},(_,i)=>({...orderFixture,number:'CVM-QA-'+(i+1),createdAt:new Date(Date.UTC(2026,10,20-i)).toISOString(),items:orderFixture.items})));
createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost:8788');
 const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 if(url.pathname==='/__qa/offline'){offline=!offline;return json({offline});}
 if(url.pathname.startsWith('/api/')){
  let body={};if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);try{body=JSON.parse(Buffer.concat(chunks));}catch{return json({},400);}}
  if(offline&&req.method==='POST')return json({error:{message:'Offline fixture: no changes saved'}},503);
  if(url.pathname==='/api/auth/session')return json({account,isAdmin:true,recoveryOnly:false});
  if(url.pathname==='/api/admin/access')return json({account,isAdmin:true});
  if(url.pathname==='/api/admin/products'){
   if(req.method==='POST'){const p=products.find(p=>p.sku===body.sku);if(!p||p.version!==body.version)return json({error:{message:'Version conflict'}},409);Object.assign(p,body.fields);if(body.stock!==undefined)p.stock=body.stock;p.version++;return json({product:p});}
   return json({products});
  }
  if(url.pathname==='/api/admin/import')return json({count:body.rows.length});
  if(url.pathname==='/api/admin/orders')return json({orders});
  if(url.pathname==='/api/orders')return json({orders});
  if(url.pathname==='/api/admin/order-actions')return json({ok:true,testMode:true});
  if(url.pathname==='/api/admin/email-jobs')return json({jobs:[]});
  if(url.pathname==='/api/admin/search')return json({searches:[{term:'qa',searches:3,misses:0}]});
  if(url.pathname==='/api/admin/categories')return json({categories:[category]});
  if(url.pathname==='/api/admin/traffic')return json({traffic:[{day:'2026-11-20',visit_sessions:12,cart_sessions:3}]});
  if(url.pathname==='/api/traffic')return json({recorded:true},202);
  if(url.pathname==='/api/categories')return json({categories:[category]});
  const config={homepage:{content:{title:'QA essentials',primaryLabel:'Shop products',primaryPath:'/shop',categoryTitle:'Categories',categoryIds:[category.id]},version:1},delivery:{shipping_cents:390,free_threshold_cents:5000,version:1},coupons:[]};
  if(url.pathname==='/api/admin/config')return json(config);
  if(url.pathname==='/api/config')return json({...config,homepage:config.homepage.content,delivery:[{...config.delivery,country_code:'SG'}]});
  if(url.pathname==='/api/shopping')return json({cart:[],saved:[],recent:[]});
  if(url.pathname==='/api/addresses')return json({addresses:[]});
  if(url.pathname==='/api/brands')return json({brands:['QA Brand']});
  if(url.pathname==='/api/products')return json({products,pagination:{total:products.length,totalPages:1,page:1,pageSize:30}});
  if(url.pathname.startsWith('/api/products/'))return json({product});
  return json({error:{message:'Missing QA fixture'}},404);
 }
 try{
  let path=url.pathname==='/qa'?resolve('tests/browser-acceptance.html'):url.pathname.startsWith('/fixtures/')?resolve('tests'+url.pathname):resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));
  if(!path.startsWith(root+'/')&&!path.startsWith(resolve('tests')+'/'))throw Error();
  const bytes=await readFile(path);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})[extname(path)]??'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(8788,'127.0.0.1',()=>console.log('Isolated QA: http://127.0.0.1:8788/qa and /#/admin/products'));
