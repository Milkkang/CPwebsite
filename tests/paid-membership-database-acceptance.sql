begin;

do $$
declare
 buyer uuid := '10914a68-95e0-4642-a492-1b11bbc47701';
 other_buyer uuid := '10914a68-95e0-4642-a492-1b11bbc47702';
 core_origin text := 'https://cpvaluemart.com';
 purchase uuid;
 next_purchase uuid;
 checkout jsonb;
 result jsonb;
 bought_at timestamptz;
 original_expiry timestamptz;
 anchor timestamptz;
 current_expiry timestamptz;
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (buyer,'annual@example.invalid',now()),(other_buyer,'other-annual@example.invalid',now());
 if public.read_paid_membership(buyer,false,null)->>'status' <> 'none' then
  raise exception 'New annual membership state was not empty';
 end if;
 checkout:=public.prepare_paid_membership_checkout(buyer,false,core_origin);
 purchase:=(checkout->>'id')::uuid;
 if public.prepare_paid_membership_checkout(buyer,false,core_origin)->>'id' <> purchase::text then
  raise exception 'Repeated checkout opened a second purchase';
 end if;
 if public.attach_paid_membership_checkout(other_buyer,false,purchase,'cs_test_annual_one') then
  raise exception 'Other member could attach a checkout';
 end if;
 bought_at:=date_trunc('second',clock_timestamp());
 if not public.attach_paid_membership_checkout(buyer,false,purchase,'cs_test_annual_one') then
  raise exception 'Owner could not attach their checkout';
 end if;
 begin
  perform public.apply_paid_membership_event('evt_bad_annual','checkout.session.completed',false,
   purchase,other_buyer,'cs_test_annual_one','pi_test_annual_one',1990,'sgd',bought_at);
  raise exception 'Accepted other member’s signed event';
 exception when check_violation then null;
 end;
 begin
  perform public.apply_paid_membership_event('evt_bad_annual','checkout.session.completed',false,
   purchase,buyer,'cs_test_annual_one','pi_test_annual_one',1000,'sgd',bought_at);
  raise exception 'Accepted an incorrect payment amount';
 exception when check_violation then null;
 end;
 perform public.apply_paid_membership_event('evt_annual_one','checkout.session.completed',false,
  purchase,buyer,'cs_test_annual_one','pi_test_annual_one',1990,'sgd',bought_at);
 perform public.apply_paid_membership_event('evt_annual_one','checkout.session.completed',false,
  purchase,buyer,'cs_test_annual_one','pi_test_annual_one',1990,'sgd',bought_at);
 perform public.apply_paid_membership_event('evt_annual_one_again','checkout.session.async_payment_succeeded',false,
  purchase,buyer,'cs_test_annual_one','pi_test_annual_one',1990,'sgd',bought_at);
 perform public.apply_paid_membership_event('evt_annual_one_expired','checkout.session.expired',false,
  purchase,buyer,'cs_test_annual_one',null,1990,'sgd',bought_at);

 select starts_at,expires_at into anchor,original_expiry
  from public.active_paid_membership_period(buyer,false,bought_at);
 if anchor is distinct from bought_at or original_expiry is distinct from bought_at+interval '1 year' then
  raise exception 'Duplicate or out-of-order confirmation changed the annual term';
 end if;
 if exists(select from public.active_paid_membership_period(buyer,true,bought_at))
  or exists(select from public.active_paid_membership_period(other_buyer,false,bought_at))
  or (public.read_paid_membership(other_buyer,false,purchase)->>'purchaseStatus') is not null
  or exists(select from public.orders where user_id=buyer) then
  raise exception 'Annual pass leaked across accounts or modes, or created a merchandise order';
 end if;
 begin
  perform public.prepare_paid_membership_checkout(buyer,false,core_origin);
  raise exception 'Allowed renewal more than 30 days early';
 exception when check_violation then
  if sqlerrm <> 'ANNUAL_PASS_NOT_RENEWABLE' then raise; end if;
 end;

 -- Arrange an already verified term at the lower renewal boundary, while using
 -- the real admission and settlement RPCs for the next purchase.
 original_expiry:=now()+interval '30 days';
 update public.paid_membership_purchases set
  starts_at=original_expiry-interval '1 year',expires_at=original_expiry
  where id=purchase;
 result:=public.read_paid_membership(buyer,false,purchase);
 if result->>'status' <> 'active' or result->>'canPurchase' <> 'true' or result->>'purchaseStatus' <> 'paid' then
  raise exception 'Annual status at the 30-day renewal boundary was incorrect: %',result;
 end if;
 next_purchase:=(public.prepare_paid_membership_checkout(buyer,false,core_origin)->>'id')::uuid;
 perform public.attach_paid_membership_checkout(buyer,false,next_purchase,'cs_test_annual_two');
 bought_at:=date_trunc('second',clock_timestamp());
 perform public.apply_paid_membership_event('evt_annual_two','checkout.session.completed',false,
  next_purchase,buyer,'cs_test_annual_two','pi_test_annual_two',1990,'sgd',bought_at);

 select starts_at,expires_at into anchor,current_expiry
  from public.active_paid_membership_period(buyer,false,original_expiry);
 if anchor is distinct from original_expiry or current_expiry is distinct from original_expiry+interval '1 year' then
  raise exception 'Early renewal did not begin at the original expiry boundary';
 end if;
 result:=public.read_paid_membership(buyer,false,next_purchase);
 if (result->'nextPeriod'->>'startsAt')::timestamptz is distinct from original_expiry
  or result->>'canPurchase'<>'false' then
  raise exception 'Queued renewal did not surface cleanly: %',result;
 end if;

 update public.paid_membership_purchases set starts_at=starts_at-interval '5 years',expires_at=expires_at-interval '5 years'
  where user_id=buyer;
 if public.read_paid_membership(buyer,false,null)->>'status'<>'expired'
  or exists(select from public.active_paid_membership_period(buyer,false,bought_at)) then
  raise exception 'An expired annual pass is still active';
 end if;
 next_purchase:=(public.prepare_paid_membership_checkout(buyer,false,core_origin)->>'id')::uuid;
 perform public.attach_paid_membership_checkout(buyer,false,next_purchase,'cs_test_annual_three');
 bought_at:=date_trunc('second',clock_timestamp());
 perform public.apply_paid_membership_event('evt_annual_three','checkout.session.completed',false,
  next_purchase,buyer,'cs_test_annual_three','pi_test_annual_three',1990,'sgd',bought_at);
 select starts_at into anchor from public.active_paid_membership_period(buyer,false,bought_at);
 if anchor is distinct from bought_at then raise exception 'Rejoining after expiry should start at payment'; end if;

 if has_function_privilege('authenticated','public.read_paid_membership(uuid,boolean,uuid)','EXECUTE')
  or has_function_privilege('anon','public.active_paid_membership_period(uuid,boolean,timestamptz)','EXECUTE')
  or has_table_privilege('authenticated','public.paid_membership_purchases','SELECT') then
  raise exception 'Direct customer access bypasses the Worker owner check';
 end if;
end;
$$;

rollback;
