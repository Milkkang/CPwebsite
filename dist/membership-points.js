import {escape as e} from './store.js';

const pointsDate=new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeZone:'Asia/Singapore'});
const pointsNumber=new Intl.NumberFormat('en-SG');
const kinds={
  adjusted:'Manual adjustment',reserved:'Held for checkout',redeemed:'Redeemed',
  released:'Checkout hold released',pending:'Earned, awaiting delivery',credited:'Available after delivery',
  restored:'Returned points',clawed_back:'Points deducted after a refund',debt_repaid:'Applied to a prior refund'
};
const date=value=>value?pointsDate.format(new Date(value)):'—';
const number=value=>pointsNumber.format(value);

export function pointsBalance(points,{audit=false}={}) {
  if(!points)return '';
  const entries=points.ledger??[];
  return '<div class="points-balance"><dl class="points-totals">'+
    '<div><dt>Available points</dt><dd>'+number(points.available)+'</dd></div>'+
    '<div><dt>Pending delivery</dt><dd>'+number(points.pending)+'</dd></div>'+
    '<div><dt>Expiring within 30 days</dt><dd>'+number(points.expiring)+'</dd></div></dl>'+
    (points.nextExpiryAt?'<p>Next expiry '+e(date(points.nextExpiryAt))+' (Singapore time).</p>':'')+
    (points.debt?'<p>'+number(points.debt)+' points from future purchases will cover past refunds.</p>':'')+
    '<h3>Recent points activity</h3>'+
    (entries.length?'<div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Activity</th>'+
    '<th scope="col">Points</th><th scope="col">Expiry</th>'+
    (audit?'<th scope="col">Reason</th><th scope="col">Operator account</th>':'')+'</tr></thead><tbody>'+
    entries.map(row=>'<tr><td>'+e(date(row.createdAt))+'</td><td>'+e(kinds[row.kind]??row.kind)+
      (row.orderNumber?'<br>'+e(row.orderNumber):'')+'</td><td>'+number(row.points)+'</td><td>'+e(date(row.expiresAt))+'</td>'+
      (audit?'<td>'+e(row.reason??'—')+'</td><td>'+e(row.actorEmail??row.actor??'—')+'</td>':'')+'</tr>').join('')+
    '</tbody></table></div>':'<p class="subtle">No points activity yet.</p>')+'</div>';
}

export function pointsBasketControl({membership,points=0,quote,error}={}) {
  const balance=membership?.points;
  if(!balance&&!points)return '';
  const available=balance?.available??0;
  const activity=points?(error??(quote?'Points applied.':'Checking your points…')):'';
  return '<div class="points-redemption"><h3>Use points</h3>'+
    '<p>'+number(available)+' available. 100 points save S$1. Use at least 100 points, up to 10% of the product subtotal after your coupon.</p>'+
    (quote&&Number.isInteger(quote.maxPoints)?'<p>Maximum for this basket '+number(quote.maxPoints)+' points.</p>':'')+
    (available>=100||points?'<form class="coupon-form" id="points-redemption"><label>Points to use <input name="points" type="number" min="0" step="1" required value="'+points+'"></label>'+
      '<button class="btn outline">Apply points</button>'+
      (points?'<button class="btn outline" type="button" data-remove-points>Remove points</button>':'')+'</form>':'')+
    (activity?'<p role="status">'+e(activity)+'</p>':'')+'</div>';
}

export function adminPointsPage({email='',accountId,verified,points,error}={}) {
  return '<div class="admin-heading"><h1>Membership points</h1></div>'+
    '<form class="panel narrow form-stack" id="member-points-search"><label>Customer account email <input type="email" name="email" required maxlength="254" value="'+e(email)+'"></label>'+
    '<button class="btn primary">Look up points</button><p role="status" data-points-feedback'+(error?'':' hidden')+'>'+e(error??'')+'</p></form>'+
    (accountId?'<section class="panel points-balance"><h2>'+e(email)+'</h2>'+pointsBalance(points,{audit:true})+'</section>'+
      (verified?'<form class="panel narrow form-stack" id="member-points-adjust"><h2>Adjust points</h2>'+
        '<label>Points to add or deduct <input type="number" name="points" required step="1" min="-1000000" max="1000000"></label>'+
        '<label>Reason <textarea name="reason" required maxlength="500" rows="3"></textarea></label>'+
        '<button class="btn primary">Save adjustment</button><p role="status" data-points-feedback hidden></p></form>':''):'');
}
