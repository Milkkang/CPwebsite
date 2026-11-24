import { cash, escape as e } from './store.js';

const endpoint='/api/membership/annual';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const singaporeTime=new Intl.DateTimeFormat('en-SG',{
 day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Singapore'
});
function annualDate(value){
 const date=new Date(value);
 return '<time datetime="'+e(date.toISOString())+'">'+e(singaporeTime.format(date))+'</time>';
}
function dateRow(label,value){
 return '<div><dt>'+label+'</dt><dd>'+annualDate(value)+'</dd></div>';
}
function checkoutNotice(pass,outcome){
 if(!outcome)return '';
 if(pass.purchaseStatus==='paid')return 'Annual pass payment confirmed.';
 if(['failed','expired'].includes(pass.purchaseStatus))return 'This payment did not complete. You can start a new checkout.';
 if(outcome==='cancel')return 'You left Stripe. You can resume your checkout while it is open.';
 if(pass.purchaseStatus==='pending')return 'Waiting for Stripe to confirm your payment. Check again in a moment.';
 return '';
}
export function annualPassPanel(pass,outcome=''){
 if(!pass?.enabled)return '';
 const status={active:'Active',expired:'Expired',none:'Available'}[pass.status];
 const purchasing=pass.available&&(pass.canPurchase||pass.pendingCheckout);
 const waiting=outcome==='return'&&pass.purchaseStatus==='pending';
 const purchaseLabel=pass.pendingCheckout?'Resume Stripe checkout':
  pass.status==='active'?'Renew annual pass':pass.status==='expired'?'Buy annual pass again':'Buy annual pass';
 const period=pass.period?'<dl class="annual-pass-dates">'+dateRow('Started',pass.period.startsAt)+
  dateRow(pass.status==='expired'?'Expired on':'Expires',pass.period.expiresAt)+(pass.nextPeriod?dateRow('Next term starts',pass.nextPeriod.startsAt)+
  dateRow('Next term expires',pass.nextPeriod.expiresAt):'')+'</dl><p class="annual-pass-timezone">Singapore time</p>':'';
 const notice=checkoutNotice(pass,outcome);
 return '<section class="panel annual-pass" aria-labelledby="annual-pass-title"><div class="annual-pass-heading"><h2 id="annual-pass-title">Annual pass</h2>'+
  '<span class="annual-pass-status" data-status="'+e(pass.status)+'">'+e(status)+'</span></div>'+
  (notice?'<p class="notice" role="status">'+notice+'</p>':'')+
  (pass.testMode?'<p class="subtle">Sandbox · Test payments only</p>':'')+period+
  (waiting?'<div><button type="button" class="btn outline small" data-refresh-annual>Check payment status</button></div>':'')+
  (!pass.available&&!pass.period?'<p>Annual pass checkout is currently unavailable.</p>':'')+
  (!waiting&&purchasing?
   '<form class="annual-pass-form" data-annual-purchase><p class="annual-pass-price"><strong>'+cash(pass.fee)+
   '</strong> for '+e(pass.termMonths)+' months</p>'+
   '<p>Renew manually. You can renew up to 30 days early and keep the full time you have already paid for.</p>'+
   '<p id="annual-pass-refund">We do not offer voluntary refunds for the annual fee. Your statutory consumer rights apply.</p>'+
   '<label class="annual-pass-consent"><input type="checkbox" name="acceptTerms" required aria-describedby="annual-pass-refund"> I agree to the annual pass terms.</label>'+
   '<div><button type="submit" class="btn primary">'+purchaseLabel+'</button></div><p class="notice" data-annual-action-status role="status" hidden></p></form>':
   !waiting&&pass.renewableAt?'<p>Manual renewal opens '+annualDate(pass.renewableAt)+' (Singapore time).</p>':'')+
  '</section>';
}

export function annualMembershipReturn(params){
 const purchase=params.get('purchase_id');
 const outcome=params.get('annual');
 return uuid.test(purchase??'')&&['return','cancel'].includes(outcome)?{purchase,outcome}:null;
}

export function createAnnualMembership(request,redirect){
 let current;
 function paint(check){
  if(current!==check||!check.element?.isConnected)return;
  const oldForm=check.element.querySelector('[data-annual-purchase]');
  if(oldForm?.elements.acceptTerms.checked)check.accepted=true;
  const html=check.error
   ?'<section class="panel annual-pass"><h2>Annual pass</h2><p role="alert">Unable to check your annual pass.</p><div><button class="btn outline small" type="button" data-refresh-annual>Retry</button></div></section>'
   :annualPassPanel(check.data,check.result?.outcome)||
    (check.result&&!check.data?'<p class="notice" role="status">Checking annual pass payment…</p>':'');
  check.element.innerHTML=html;
  check.element.hidden=!html;
  check.element.querySelector('[data-refresh-annual]')?.addEventListener('click',()=>load(check));
  const form=check.element.querySelector('[data-annual-purchase]');
  if(!form)return;
  const checkbox=form.elements.acceptTerms;
  checkbox.checked=check.accepted===true;
  checkbox.addEventListener('change',()=>{check.accepted=checkbox.checked;});
  const button=form.querySelector('button[type=submit]');
  const status=form.querySelector('[data-annual-action-status]');
  button.disabled=check.submitting===true;
  status.hidden=!check.submitting;
  if(check.submitting)status.textContent='Opening Stripe checkout…';
  form.addEventListener('submit',async event=>{
   event.preventDefault();
   if(current!==check||check.submitting||!checkbox.checked)return;
   check.submitting=true;
   button.disabled=true;
   status.hidden=false;
   status.textContent='Opening Stripe checkout…';
   try{
    const result=await request(endpoint,{acceptTerms:true});
    if(current!==check||result.accountId!==check.owner)return;
    if(result.checkoutUrl?.startsWith('https://checkout.stripe.com/'))redirect(result.checkoutUrl);
    else if(result.pending&&uuid.test(result.purchaseId??''))
     redirect('/#/account?purchase_id='+result.purchaseId+'&annual=return');
    else throw Error('Annual pass checkout is unavailable. Please try again.');
   }catch(error){
    if(current!==check)return;
    const target=check.element?.querySelector('[data-annual-action-status]');
    if(target){target.hidden=false;target.textContent=error.message;}
   }finally{
    check.submitting=false;
    const target=check.element?.querySelector('[data-annual-purchase] button');
    if(target)target.disabled=false;
   }
  });
 }
 async function load(check){
  if(current!==check||check.loading)return;
  check.loading=true;
  try{
   let data;
   try{data=await request(endpoint+(check.result?'?purchase_id='+check.result.purchase:''));}
   catch(error){
    if(error.code!=='PURCHASE_NOT_FOUND')throw error;
    check.result=null;
    data=await request(endpoint);
   }
   if(data.accountId!==check.owner)return;
   check.data=data;
   check.error=false;
  }catch{
   if(check.result||check.data?.enabled)check.error=true;
  }finally{
   check.loading=false;
   paint(check);
  }
 }
 return {
  sync(element,owner,result){
   if(!element||!owner){current=undefined;return;}
   const key=owner+':'+(result?.purchase??'')+':'+(result?.outcome??'');
   if(current?.key===key){
    if(current.element!==element){current.element=element;paint(current);}
    return;
   }
   current={key,owner,result,element};
   paint(current);
   load(current);
  },
  reset(){current=undefined;}
 };
}
