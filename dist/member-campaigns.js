import {cash,escape as e} from './store.js';

const singaporeTime=new Intl.DateTimeFormat('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Singapore'});
const audiences={all:'All members',new:'Members without a paid order',returning:'Members with a paid order'};
const timeLabel=value=>singaporeTime.format(new Date(value));
const discountValue=campaign=>campaign.type==='fixed'?cash(campaign.amount):campaign.amount+'%';

export function campaignTerms(campaign) {
 return discountValue(campaign)+' off products'+(campaign.minimum?' with a '+cash(campaign.minimum)+' product minimum':'');
}
export function campaignAvailability(campaign) {
 return campaignTerms(campaign)+'. Valid until '+timeLabel(campaign.expiresAt)+' (Singapore time).';
}
export function adminCampaignPanel(result) {
 const rows=result?.campaigns;
 return '<section class="panel form-stack"><div class="section-title"><h2>Member campaigns</h2>'+
  (rows?'<button type="button" class="btn primary" data-edit-member-campaign="">Add campaign</button>':'')+'</div>'+
  (rows?(rows.length?'<div class="table-wrap"><table><thead><tr>'+['Campaign','Audience','Limits','Redemptions','Status','Edit'].map(label=>'<th scope="col">'+label+'</th>').join('')+
   '</tr></thead><tbody>'+rows.map(campaign=>{
    const status=!campaign.active?'Paused':Date.now()<Date.parse(campaign.startsAt)?'Scheduled':Date.now()>=Date.parse(campaign.expiresAt)?'Ended':'Active';
    return '<tr><th scope="row">'+e(campaign.title)+'<br><span class="subtle">'+e(campaignTerms(campaign))+'</span><br><span class="subtle">'+
     e(timeLabel(campaign.startsAt)+' to '+timeLabel(campaign.expiresAt))+' (Singapore time)</span></th><td>'+e(audiences[campaign.audience])+'</td>'+
     '<td>'+e(campaign.memberLimit)+' per member<br>'+e(campaign.totalLimit)+' total</td><td>'+e(campaign.redeemed)+' paid · '+e(campaign.reserved)+' reserved'+
     '<br><span class="subtle">Sandbox '+e(campaign.testRedeemed)+' paid · '+e(campaign.testReserved)+' reserved</span></td><td>'+status+'</td>'+
     '<td><button type="button" class="btn small outline" data-edit-member-campaign="'+e(campaign.id)+'" aria-label="Edit '+e(campaign.title)+'">Edit</button></td></tr>';
   }).join('')+'</tbody></table></div>':'<p class="subtle">No member campaigns yet.</p>'):
   '<p role="status">'+e(result?.error||'Loading member campaigns…')+'</p>'+(result?.error?'<button type="button" class="btn outline" data-retry-member-campaigns>Retry</button>':''))+'</section>';
}

function localDate(value) {
 return value?new Date(Date.parse(value)+8*60*60*1000).toISOString().slice(0,19):'';
}
export function adminCampaignEditor(campaign={type:'fixed',minimum:0,audience:'all',memberLimit:1}) {
 const option=(value,label,current)=>'<option value="'+e(value)+'"'+(current===value?' selected':'')+'>'+e(label)+'</option>';
 const input=(name,label,value,attributes)=>'<label>'+label+'<input name="'+name+'" value="'+e(value)+'" '+attributes+' required></label>';
 return '<form class="form-stack" id="member-campaign-editor" data-id="'+e(campaign.id)+'" data-version="'+(campaign.version??0)+'">'+
  '<h2 id="dialog-title">'+(campaign.id?'Edit campaign':'Add campaign')+'</h2>'+
  input('title','Campaign name',campaign.title,'maxlength="100"')+
  '<label>Discount type<select name="type">'+option('fixed','Fixed SGD amount',campaign.type)+option('percent','Percentage',campaign.type)+'</select></label>'+
  input('amount','Discount value (SGD or whole %)',campaign.type==='fixed'&&campaign.amount?campaign.amount/100:campaign.amount,'type="number" min="0.01" step="0.01"')+
  input('minimum','Minimum product subtotal (SGD)',campaign.minimum/100,'type="number" min="0" step="0.01"')+
  '<label>Eligible members<select name="audience">'+Object.entries(audiences).map(([value,label])=>option(value,label,campaign.audience)).join('')+'</select></label>'+
  input('startsAt','Starts (Singapore time)',localDate(campaign.startsAt),'type="datetime-local" step="1"')+
  input('expiresAt','Ends (Singapore time)',localDate(campaign.expiresAt),'type="datetime-local" step="1"')+
  input('memberLimit','Maximum uses per member',campaign.memberLimit,'type="number" min="1" step="1"')+
  input('totalLimit','Maximum uses across members',campaign.totalLimit,'type="number" min="1" step="1"')+
  '<label class="check-label"><input type="checkbox" name="active"'+(campaign.active?' checked':'')+'> Campaign enabled</label>'+
  '<button type="submit" class="btn primary">Save campaign</button></form>';
}
export function adminCampaignInput(form,values) {
 const date=field=>{
  const parsed=new Date(String(values.get(field))+'+08:00');
  if(!Number.isFinite(parsed.getTime()))throw Error('Enter valid Singapore start and end times.');
  return parsed.toISOString();
 };
 const type=values.get('type'),amount=Number(values.get('amount'));
 return {id:form.dataset.id||null,version:Number(form.dataset.version),title:values.get('title'),type,
  amount:type==='fixed'?Math.round(amount*100):amount,minimum:Math.round(Number(values.get('minimum'))*100),
  startsAt:date('startsAt'),expiresAt:date('expiresAt'),audience:values.get('audience'),
  memberLimit:Number(values.get('memberLimit')),totalLimit:Number(values.get('totalLimit')),active:values.has('active')};
}
