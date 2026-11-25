import {cash,escape as e,netOrderTotal} from './store.js';
import {href} from './shop.js';

const metrics=[
  {key:'sales',label:'Sales',unit:'money',value:row=>row.sales},
  {key:'orders',label:'Orders',unit:'count',value:row=>row.orders},
  {key:'sales-per-order',label:'Sales per order',unit:'money',value:row=>row.orders?row.sales/row.orders:0},
  {key:'visitors',label:'Visitor sessions',unit:'count',value:row=>row.visitors},
  {key:'cart-visitors',label:'Add-to-cart sessions',unit:'count',value:row=>row.cartVisitors},
  {key:'cart-rate',label:'Add-to-cart session rate',unit:'percent',value:row=>row.visitors?100*row.cartVisitors/row.visitors:0}
];
const DAY=86_400_000;
const parseDate=key=>new Date(key+'T00:00:00Z');
const dateKey=time=>new Date(time).toISOString().slice(0,10);
const dateLabel=new Intl.DateTimeFormat('en-SG',{day:'numeric',month:'short',timeZone:'UTC'});
const monthLabel=new Intl.DateTimeFormat('en-SG',{month:'short',year:'2-digit',timeZone:'UTC'});
const yearLabel=new Intl.DateTimeFormat('en-SG',{year:'numeric',timeZone:'UTC'});
const countFormat=new Intl.NumberFormat('en-SG');
const compactFormat=new Intl.NumberFormat('en-SG',{notation:'compact',maximumFractionDigits:1});
const formatValue=(metric,value)=>metric.unit==='money'?cash(value):metric.unit==='percent'?value.toFixed(1)+'%':countFormat.format(value);
const unitLabel=(metric,value)=>metric.unit==='money'?'S$'+compactFormat.format(value/100):
  metric.unit==='percent'?compactFormat.format(value)+'%':compactFormat.format(value);


const totalsRow=()=>({sales:0,orders:0,visitors:0,cartVisitors:0});
export function analyticsData({from,to},range,orders,traffic=[]) {
  const totals=totalsRow();
  const daily=new Map();
  for(const order of orders) {
    if(order.status==='Cancelled'||order.date<from||order.date>to) continue;
    const day=daily.get(order.date)??totalsRow();
    if(order.livePayment&&order.paymentStatus==='paid')day.sales+=netOrderTotal(order);
    day.orders++;
    daily.set(order.date,day);
  }

  const visits=new Map(traffic.map(row=>[row.day,row]));
  const grouping=range==='1y'?'month':range==='3m'?'week':'day';
  const first=parseDate(from).getTime(), last=parseDate(to).getTime();
  const buckets=new Map();
  for(let time=first;time<=last;time+=DAY) {
    const date=dateKey(time);
    const key=grouping==='month'?date.slice(0,7):grouping==='week'?Math.floor((time-first)/(7*DAY)):date;
    const bucket=buckets.get(key)??{from:date,to:date,...totalsRow()};
    const visitors=Number(visits.get(date)?.visit_sessions??0),cartVisitors=Number(visits.get(date)?.cart_sessions??0);
    const values={...(daily.get(date)??totalsRow()),visitors,cartVisitors};
    for(const field of Object.keys(totals)) {
      bucket[field]+=values[field];
      totals[field]+=values[field];
    }
    bucket.to=date;
    buckets.set(key,bucket);
  }
  return {totals,buckets:[...buckets.values()],grouping};
}

function tickValues(metric,values) {
  const max=Math.max(...values,0);
  const minStep=metric.unit==='money'?25:metric.unit==='count'?1:0.25;
  const rough=Math.max(max/4,minStep);
  const factor=10**Math.floor(Math.log10(rough));
  const rounded=[1,2,2.5,5,10].find(value=>value*factor>=rough)*factor;
  const step=metric.unit==='count'?Math.ceil(rounded):rounded;
  return [4*step,3*step,2*step,step,0];
}

function bucketLabel(bucket,grouping) {
  return (grouping==='year'?yearLabel:grouping==='month'?monthLabel:dateLabel).format(parseDate(bucket.from));
}

function chart(metric,buckets,grouping,groupLabel={day:'Daily',week:'Weekly',month:'Monthly',year:'Yearly'}[grouping]) {
  const values=buckets.map(bucket=>metric.value(bucket));
  const ticks=tickValues(metric,values);
  const points=values.map((value,i)=>({
    x:100*(i+0.5)/values.length,
    y:100*(1-value/ticks[0]),
    value,
    label:bucketLabel(buckets[i],grouping),
    date:buckets[i].from===buckets[i].to?buckets[i].from:buckets[i].from+' to '+buckets[i].to
  }));
  const coords=points.map(({x,y})=>x.toFixed(3)+','+y.toFixed(3)).join(' ');
  const tickIndexes=new Set(Array.from({length:Math.min(points.length,6)},(_,i)=>
    points.length<=6?i:Math.round(i*(points.length-1)/5)
  ));
  const middleTick=[...tickIndexes][Math.floor(tickIndexes.size/2)];
  const dateTicks=points.map(({x,label},i)=>tickIndexes.has(i)?
    '<span class="'+(tickIndexes.size>3&&i!==0&&i!==points.length-1&&i!==middleTick?'extra-date':'')+'" style="--x:'+x+'%">'+e(label)+'</span>':'').join('');
  const targets=points.map(({y,date,value})=>{
    const shown=formatValue(metric,value);
    return '<button class="chart-target" type="button" aria-label="'+e(date+', '+shown)+'" style="--y:'+y+'%">'+
      '<span class="chart-marker" aria-hidden="true"></span><span class="chart-tooltip" aria-hidden="true"><span>'+e(date)+'</span><strong>'+e(shown)+'</strong></span></button>';
  }).join('');

  return '<figure class="panel trend-panel" aria-labelledby="trend-title"><figcaption><h2 id="trend-title">'+e(metric.label)+' trend</h2>'+
    '<span class="subtle">'+e(groupLabel)+'</span></figcaption>'+
    '<div class="trend-layout"><div class="trend-axis" aria-hidden="true">'+ticks.map((value,i)=>
      '<span style="--y:'+25*i+'%">'+e(unitLabel(metric,value))+'</span>').join('')+'</div>'+
    '<div class="trend-plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">'+
    ticks.map((_,i)=>'<line class="trend-gridline" x1="0" x2="100" y1="'+25*i+'" y2="'+25*i+'" vector-effect="non-scaling-stroke"/>').join('')+
    (points.length>1?'<polyline class="trend-line" points="'+coords+'" vector-effect="non-scaling-stroke"/>':'')+'</svg>'+
    '<div class="chart-targets">'+targets+'</div></div>'+
    '<div class="trend-dates" aria-hidden="true">'+dateTicks+'</div></div></figure>';
}

export function overviewAnalytics(period,filters,orders,requestedMetric,traffic=[]) {
  const metric=metrics.find(item=>item.key===requestedMetric)??metrics[0];
  const {totals,buckets,grouping}=analyticsData(period,filters.range,orders,traffic);
  const cards=metrics.map(item=>{
    const active=item===metric;
    return '<a href="'+e(href('/admin',{...filters,metric:item.key}))+'" class="panel metric-card'+(active?' metric-active':'')+'"'+
      (active?' aria-current="true"':'')+'><span>'+e(item.label)+'</span><strong>'+e(formatValue(item,item.value(totals)))+'</strong></a>';
  }).join('');
  return '<section class="overview-analytics" aria-label="Store performance"><div class="metric-grid">'+cards+'</div>'+
    chart(metric,buckets,grouping)+'<p class="subtle traffic-note">First-party session counts begin when tracking is enabled. Each browser tab counts once per Singapore day; blocked scripts and bots may affect totals.</p></section>';
}

const revenueMetrics=[
  {...metrics[0],key:'revenue',label:'Order revenue'},
  {...metrics[1],label:'Orders counted'},
  {...metrics[2],label:'Average order value'},
  {key:'cancelled',label:'Cancelled orders',unit:'count',value:row=>row.cancelled}
];
function addRevenueOrder(bucket,order) {
  if(!order.livePayment)return;
  if(order.status==='Cancelled') bucket.cancelled++;
  else if(order.paymentStatus==='paid') {
    bucket.sales+=netOrderTotal(order);
    bucket.orders++;
  }
}
function revenueBuckets(period,orders) {
  const start=parseDate(period.from), end=parseDate(period.to);
  const from=start.getTime(), endExclusive=end.getTime()+DAY, days=(endExclusive-from)/DAY;
  const months=(end.getUTCFullYear()-start.getUTCFullYear())*12+end.getUTCMonth()-start.getUTCMonth()+1;
  const grouping=days<=31?'day':days<=100?'week':months<=24?'month':'year';
  const yearsPerBucket=Math.ceil((end.getUTCFullYear()-start.getUTCFullYear()+1)/24);
  const buckets=[];
  const totals={sales:0,orders:0,cancelled:0};
  // Walk the selected dates in order so empty periods remain visible.
  const ordered=[...orders].sort((a,b)=>a.date.localeCompare(b.date));
  let i=0;
  for(let time=from;time<endExclusive;) {
    const date=new Date(time);
    let next=time+DAY;
    if(grouping==='week') next=time+7*DAY;
    if(grouping==='month') {
      date.setUTCDate(1);
      next=date.setUTCMonth(date.getUTCMonth()+1);
    }
    if(grouping==='year') next=date.setUTCFullYear(date.getUTCFullYear()+yearsPerBucket,0,1);
    next=Math.min(next,endExclusive);
    const bucket={from:dateKey(time),to:dateKey(next-DAY),sales:0,orders:0,cancelled:0};
    while(i<ordered.length&&ordered[i].date<=bucket.to) {
      addRevenueOrder(bucket,ordered[i]);
      addRevenueOrder(totals,ordered[i]);
      i++;
    }
    buckets.push(bucket);
    time=next;
  }
  return {buckets,totals,grouping,groupLabel:grouping==='year'&&yearsPerBucket>1?'Every '+yearsPerBucket+' years':undefined};
}
export function revenueMetric(key) {
  return revenueMetrics.find(metric=>metric.key===key)??revenueMetrics[0];
}
export function revenueAnalytics(period,orders,filters,metric) {
  const {buckets,totals,grouping,groupLabel}=revenueBuckets(period,orders);
  const cards=revenueMetrics.map(item=>{
    const active=item===metric;
    return '<a href="'+e(href('/admin/revenue',{...filters,metric:item.key}))+'" class="panel metric-card'+(active?' metric-active':'')+'"'+
      (active?' aria-current="true"':'')+'><span>'+e(item.label)+'</span><strong>'+e(formatValue(item,item.value(totals)))+'</strong></a>';
  }).join('');
  return '<section aria-label="Revenue performance"><div class="stat-grid revenue-stats">'+cards+'</div>'+
    chart(metric,buckets,grouping,groupLabel)+'</section>';
}
