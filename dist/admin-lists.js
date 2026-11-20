// Paging counts records, not date groups. Filters are applied before this step.
export function listPage(params,total){
 const requestedSize=Number(params.get('size')),requestedPage=Number(params.get('page'));
 const size=[30,50,100].includes(requestedSize)?requestedSize:30;
 const pages=Math.max(1,Math.ceil(total/size));
 const page=Math.min(pages,Number.isSafeInteger(requestedPage)&&requestedPage>0?requestedPage:1);
 return {size,pages,page,start:(page-1)*size};
}
const singaporeDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'});
export function orderDay(order){return order.createdAt?singaporeDate.format(new Date(order.createdAt)):order.date;}
export function groupOrders(orders,group='day',sort='newest'){
 const rows=[...orders].sort((a,b)=>{
  const comparison=String(a.createdAt??a.date).localeCompare(String(b.createdAt??b.date))||String(a.id).localeCompare(String(b.id),undefined,{numeric:true});
  return sort==='oldest'?comparison:-comparison;
 });
 const groups=new Map();
 for(const order of rows){
  const day=orderDay(order),date=new Date(day+'T00:00:00Z');
  let key=day,label=day;
  if(group==='week'){date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));key=date.toISOString().slice(0,10);label='Week of '+key;}
  else if(group==='month'){key=day.slice(0,7);label=new Intl.DateTimeFormat('en-SG',{month:'long',year:'numeric',timeZone:'UTC'}).format(date);}
  else if(group==='quarter'){key=day.slice(0,4)+' Q'+(Math.floor(date.getUTCMonth()/3)+1);label=key;}
  else if(group==='year'){key=day.slice(0,4);label=key;}
  if(!groups.has(key))groups.set(key,{key,label,orders:[]});
  groups.get(key).orders.push(order);
 }
 return [...groups.values()];
}
