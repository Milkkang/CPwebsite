begin;

do $$
declare
 buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid();
 address uuid:=gen_random_uuid(); prior uuid; second uuid; next_order uuid; refund uuid:=gen_random_uuid();
 launch timestamptz:=now()-interval '2 years'; payment_time timestamptz:=now()-interval '2 minutes';
 result jsonb; source record; cents integer;
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (buyer,'tier@example.invalid',launch),(other_buyer,'other-tier@example.invalid',launch),(admin,'tier-admin@example.invalid',launch);
 insert into public.admin_roles(user_id) values(admin);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values(address,buyer,'Synthetic','Synthetic','123456');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active) values('tiers-qa','SG',390,5000,true);
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values ('TIER-A','TIER-A','Tier fixture','A','Fixture','acceptance','https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',10000,20,'Published');

 -- Arrange dated deliveries; verify read and payment behavior at the RPCs.
 for source in select * from (values (29999,now()-interval '2 days',true),
   (40000,now()-interval '13 months',true),(50000,now()-interval '1 day',false)) as rows(cost,delivered,formal)
 loop
  insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
   live_payment,member_points_eligible,payment_status,fulfilment_status)
  values(buyer,address,source.cost,0,0,source.cost,source.formal,source.formal,'paid','Delivered') returning id into prior;
  insert into private.membership_point_earnings(order_id,user_id,original_points,remaining_points,multiplier,credited_at)
  values(prior,buyer,0,0,100,source.delivered);
 end loop;
 result:=public.read_membership_tier(buyer);
 if result->>'tier'<>'base' or (result->>'qualifyingSpend')::integer<>29999 then
  raise exception 'expired and sandbox purchases entered tier spend: %',result;
 end if;

 -- The S$0.01 addition moves the account to silver. A later delivery should
 -- not change the multiplier for a payment received late from Stripe.
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
  live_payment,member_points_eligible,payment_status,fulfilment_status)
 values(buyer,address,50,0,0,50,true,true,'paid','Delivered') returning id into second;
 insert into private.membership_point_earnings(order_id,user_id,original_points,remaining_points,multiplier,credited_at)
 values(second,buyer,0,0,100,payment_time-interval '1 minute');
 update public.orders set discount_cents=49,shipping_cents=49 where id=second;
 if public.read_membership_tier(buyer)->>'qualifyingSpend'<>'30000' then
  raise exception 'S$300 boundary was incorrect';
 end if;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
  live_payment,member_points_eligible,payment_status,fulfilment_status)
 values(buyer,address,60000,0,0,60000,true,true,'paid','Delivered') returning id into prior;
 insert into private.membership_point_earnings(order_id,user_id,original_points,remaining_points,multiplier,credited_at)
 values(prior,buyer,0,0,100,now()-interval '1 minute');
 if public.read_membership_tier(buyer)->>'tier'<>'gold' or public.read_membership_tier(other_buyer)->>'tier'<>'base' then
  raise exception 'gold threshold or tier account isolation was incorrect';
 end if;
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'TIER-A',1);
 result:=public.create_points_order(buyer,address,launch,true,null,null,0,null);
 next_order:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,next_order,'cs_live_tier_late');
 for i in 1..2 loop
  perform public.apply_tier_payment_event('evt_tier_late','checkout.session.completed',true,next_order,
   'cs_live_tier_late','pi_tier_late',10000,'sgd',payment_time,launch);
 end loop;
 select original_points into cents from private.membership_point_earnings where order_id=next_order;
 if cents<>125 or public.read_membership_tier(buyer)->>'qualifyingSpend'<>'90000' then
  raise exception 'payment tier changed after a later delivery or an undelivered order was counted';
 end if;
 insert into private.order_refunds(id,order_id,actor_id,item_allocations,restock,legacy,cash_cents,merchandise_cents,status,
  provider_id,provider_status,resolved_by,resolved_at)
 values(refund,prior,admin,'[]',false,false,10001,10001,'completed','re_tier_fixture','succeeded',admin,now()-interval '20 seconds');
 if public.read_membership_tier(buyer)->>'tier'<>'silver' or public.read_membership_tier(buyer)->>'qualifyingSpend'<>'79999' then
  raise exception 'net refunded merchandise did not lower the tier';
 end if;
end $$;

do $$
declare
 buyer uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid();
 address uuid:=gen_random_uuid(); purchase uuid:=gen_random_uuid(); campaign uuid; checkout_id uuid;
 launch timestamptz:=now()-interval '3 months'; result jsonb; month_token text; refund uuid;
 anchor timestamptz:='2024-01-31 10:00+08';
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (buyer,'allowance@example.invalid',launch),(outsider,'no-allowance@example.invalid',launch),(admin,'allowance-admin@example.invalid',launch);
 insert into public.admin_roles(user_id) values(admin);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values(address,buyer,'Synthetic','Synthetic','123456');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active) values('allowance-qa','SG',500,5000,true);
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values ('DELIVERY-A','DELIVERY-A','Delivery fixture','A','Fixture','acceptance','https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',3200,20,'Published');
 insert into public.paid_membership_purchases(id,user_id,livemode,return_origin,checkout_expires_at,
  status,stripe_checkout_session_id,stripe_payment_intent_id,paid_at,starts_at,expires_at)
 values(purchase,buyer,true,'https://cpvaluemart.com',now(),'paid','cs_live_allowance_card',
  'pi_allowance_card',now(),now()-interval '20 days',now()+interval '11 months'),
  (gen_random_uuid(),outsider,false,'https://cpvaluemart.com',anchor,'paid','cs_test_allowance_dates',
  'pi_test_allowance_dates',anchor,anchor,anchor+interval '12 months');
 if not exists(select 1 from private.membership_delivery_month(outsider,false,'2024-02-29 10:00+08')
   where member_month=1 and expires_at='2024-03-31 10:00+08') then
  raise exception 'February clamp or original March anchor was incorrect';
 end if;
 if public.read_membership_delivery(buyer,false) is not null or public.read_membership_delivery(outsider,true) is not null then
  raise exception 'official and test delivery allowances were not isolated';
 end if;
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'DELIVERY-A',2);
 begin
  perform public.quote_delivery_checkout(buyer,launch,true,null,null,0,true);
  raise exception 'a free-delivery order tried to consume a member allowance';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'DELIVERY_ALREADY_FREE' then raise; end if;
 end;
 update public.buyer_cart_items set quantity=1 where user_id=buyer;
 result:=public.save_member_campaign(admin,null,0,jsonb_build_object('title','Fixture', 'type','fixed','amount',300,
  'minimum',3000,'startsAt',launch,'expiresAt',now()+interval '1 day','audience','all','memberLimit',6,'totalLimit',100,'active',true));
 campaign:=(result->>'id')::uuid;
 perform public.adjust_member_points(admin,buyer,1000,'QA balance',gen_random_uuid());
 result:=public.quote_delivery_checkout(buyer,launch,true,null,null,0,true);
 checkout_id:=(public.create_delivery_order(buyer,address,launch,true,null,null,0,true,
  (result->>'total')::integer,result#>>'{deliveryAllowance,month}')->>'id')::uuid;
 update private.membership_delivery_claims set updated_at=now()-interval '6 minutes' where order_id=checkout_id;
 if not public.release_stale_member_campaign_order() then
  raise exception 'interrupted allowance-only checkout was not picked for recovery';
 end if;
 result:=public.read_membership_delivery(buyer,true);
 if result->>'status' is distinct from 'available' or
    (select reserved_quantity from public.products where sku='DELIVERY-A')<>0 then
  raise exception 'interrupted allowance-only checkout did not recover reservation and stock: %',result;
 end if;
 for i in 1..3 loop
  result:=public.quote_delivery_checkout(buyer,launch,true,campaign::text,null,200,true);
  month_token:=result#>>'{deliveryAllowance,month}';
  if result->>'total'<>'2810' or result->>'shipping'<>'110' or result#>>'{deliveryAllowance,discount}'<>'390' then
   raise exception 'coupon, points and delivery quote do not stack: %',result;
  end if;
  result:=public.create_delivery_order(buyer,address,launch,true,campaign::text,null,200,true,2810,month_token);
  checkout_id:=(result->>'id')::uuid;
  if result->>'shipping_cents'<>'110' or result#>>'{pricing,0,cash_cents}'<>'2700'
    or result->>'total_cents'<>'2810' or public.read_membership_delivery(buyer,true)->>'status'<>'reserved' then
   raise exception 'the order and reserved allowance did not match the quote: %',result;
  end if;
  begin
   perform public.create_delivery_order(buyer,address,launch,true,campaign::text,null,200,true,2810,month_token);
   raise exception 'a second open checkout reused the allowance';
  exception when sqlstate 'PT409' then
   if sqlerrm not in ('DELIVERY_ALLOWANCE_UNAVAILABLE','CHECKOUT_PENDING') then raise; end if;
  end;
  perform public.attach_test_checkout(buyer,checkout_id,'cs_live_allowance_'||i);
  if i=1 then
   perform public.apply_test_payment_event('evt_allowance_expired','checkout.session.expired',true,checkout_id,
    'cs_live_allowance_'||i,null,2810,'sgd');
  else
   perform public.apply_test_payment_event('evt_allowance_paid_'||i,'checkout.session.completed',true,checkout_id,
    'cs_live_allowance_'||i,'pi_allowance_'||i,2810,'sgd');
   if public.read_membership_delivery(buyer,true)->>'status'<>'used' then raise exception 'payment did not use the allowance'; end if;
   if i=2 then
    refund:=gen_random_uuid();
    perform public.prepare_order_refund(admin,checkout_id,(select version from public.orders where id=checkout_id),
     refund,false,true,'[{"sku":"DELIVERY-A","quantity":1}]');
    perform public.resolve_order_refund(admin,checkout_id,refund,true,'re_allowance_partial','succeeded');
    if public.read_membership_delivery(buyer,true)->>'status'<>'used' then raise exception 'partial refund restored the allowance'; end if;
   else
    perform public.admin_update_order(admin,checkout_id,(select version from public.orders where id=checkout_id),'Shipped','fixture');
   end if;
   refund:=gen_random_uuid();
   perform public.prepare_order_refund(admin,checkout_id,(select version from public.orders where id=checkout_id),refund,false,true,null);
   perform public.resolve_order_refund(admin,checkout_id,refund,true,'re_allowance_'||i,'succeeded');
   insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'DELIVERY-A',1);
  end if;
  if public.read_membership_delivery(buyer,true)->>'status' is distinct from (case when i=3 then 'used' else 'available' end) then
   raise exception 'expiry/pre-shipment full refund/post-shipment full refund rule failed, case %',i;
  end if;
 end loop;
end $$;

rollback;
