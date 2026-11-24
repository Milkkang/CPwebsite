-- Synthetic formal checkouts exercise the deployed SQL boundaries without Stripe.
begin;
do $$
declare
 buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid();
 address uuid:=gen_random_uuid(); checkout_id uuid; campaign uuid;
 launch timestamptz:=now()-interval '1 day'; request uuid:=gen_random_uuid(); reversal uuid:=gen_random_uuid(); result jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at) values
 (buyer,'points-buyer@example.invalid',launch),(other_buyer,'points-other@example.invalid',launch),
 (admin,'points-owner@example.invalid',launch);
 insert into public.admin_roles(user_id) values(admin);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(address,buyer,'Synthetic','Synthetic','123456');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values ('POINTS-A','POINTS-A','Points fixture','A','Fixture','acceptance','https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',2000,10,'Published'),
 ('POINTS-B','POINTS-B','Points fixture','B','Fixture','acceptance','https://example.invalid/b','https://example.invalid/b','https://example.invalid/b',3000,10,'Published');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active)
 values('points-test','SG',390,5000,true);
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'POINTS-A',1),(buyer,'POINTS-B',1);
 -- A previous credit is close to expiry. The new adjustment uses the usual 12-month expiry.
 insert into private.membership_point_lots(user_id,issued,remaining,expires_at) values(buyer,120,120,now()+interval '10 days');
 if public.adjust_member_points(admin,buyer,130,'Synthetic service adjustment',request)->>'available' is distinct from '250' or
    public.adjust_member_points(admin,buyer,130,'Synthetic service adjustment',request)->>'available' is distinct from '250' then
  raise exception 'administrative allocation and retry must credit once';
 end if;
 result:=public.read_admin_member_points(admin,'POINTS-BUYER@example.invalid');
 if result#>>'{points,ledger,0,actor}' is distinct from admin::text or
    result#>>'{points,ledger,0,reason}' is distinct from 'Synthetic service adjustment' then
  raise exception 'store owner needs the adjustment reason and actor';
 end if;
 if public.read_member_points(other_buyer)->>'available' is distinct from '0' or
    public.read_member_points(buyer)#>'{ledger,0,actor}' is not null then
  raise exception 'customer balances and private administrator information must stay isolated';
 end if;
 begin
  perform public.read_admin_member_points(other_buyer,'points-buyer@example.invalid');
  raise exception 'buyer looked up another account';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.quote_points_checkout(buyer,launch,false,'welcome',null,200);
  raise exception 'sandbox checkout could redeem real points';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'POINTS_UNAVAILABLE' then raise; end if;
 end;
 result:=public.quote_points_checkout(buyer,launch,true,'welcome',null,200);
 if result->>'total' is distinct from '4500' or result->>'couponDiscount' is distinct from '300' or
    result->>'pointsDiscount' is distinct from '200' or result->>'maxPoints' is distinct from '250' then
  raise exception 'wrong combined coupon and points quote: %',result;
 end if;
 result:=public.create_points_order(buyer,address,launch,true,'welcome',null,200,4500);
 checkout_id:=(result->>'id')::uuid;
 if result->>'total_cents' is distinct from '4500'
    or result#>>'{pricing,0,point_cents}' is distinct from '80'
    or result#>>'{pricing,0,cash_cents}' is distinct from '1800'
    or public.read_member_points(buyer)->>'available' is distinct from '50' then
  raise exception 'wrong order pricing or spendable balance after checkout hold';
 end if;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_points_expired');
 perform public.apply_test_payment_event('evt_points_expired','checkout.session.expired',true,
  checkout_id,'cs_live_points_expired',null,4500,'sgd');
 if public.read_member_points(buyer)->>'available' is distinct from '250' then
  raise exception 'expiry did not release held points';
 end if;
 result:=public.save_member_campaign(admin,null,0,jsonb_build_object('title','Combined offer','type','fixed','amount',300,
  'minimum',5000,'startsAt',launch,'expiresAt',now()+interval '1 day','audience','all','memberLimit',1,'totalLimit',1,'active',true));
 campaign:=(result->>'id')::uuid;
 result:=public.quote_points_checkout(buyer,launch,true,campaign::text,null,200);
 if result->>'total' is distinct from '4500' or result->>'couponDiscount' is distinct from '300' or
    result->>'pointsDiscount' is distinct from '200' then
  raise exception 'campaign discount and points failed to quote in the same order: %',result;
 end if;
 result:=public.create_points_order(buyer,address,launch,true,campaign::text,null,200,4500);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_points_paid');
 perform public.apply_test_payment_event('evt_points_paid','checkout.session.completed',true,
  checkout_id,'cs_live_points_paid','pi_points_paid',4500,'sgd');
 perform public.apply_test_payment_event('evt_points_paid','checkout.session.completed',true,
  checkout_id,'cs_live_points_paid','pi_points_paid',4500,'sgd');
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '50' or result->>'pending' is distinct from '45' or result->>'expiring' is distinct from '0' or
    public.read_member_campaigns(admin)#>>'{0,redeemed}' is distinct from '1' then
  raise exception 'formal payment should debit once and record 45 pending points: %',result;
 end if;
 perform public.admin_update_order(admin,checkout_id,(select version from public.orders where id=checkout_id),'Shipped','Synthetic');
 if not public.confirm_test_order_receipt(buyer,checkout_id,(select version from public.orders where id=checkout_id)) then
  raise exception 'buyer receipt failed';
 end if;
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '95' or result->>'pending' is distinct from '0' then
  raise exception 'delivery should credit the pending points once: %',result;
 end if;
 perform private.apply_membership_points_refund(checkout_id,reversal,18,'[{"offset":0,"points":80}]');
 perform private.apply_membership_points_refund(checkout_id,reversal,18,'[{"offset":0,"points":80}]');
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '157' or result->>'expiring' is distinct from '62' then
  raise exception 'refund must restore the oldest lot with its original expiry and claw back once: %',result;
 end if;
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'POINTS-A',1),(buyer,'POINTS-B',1);
 result:=public.quote_points_checkout(buyer,launch,true,null,null,150);
 if result->>'total' is distinct from '4850' then raise exception 'points require no coupon: %',result; end if;
 result:=public.create_points_order(buyer,address,launch,true,null,null,150,4850);
 checkout_id:=(result->>'id')::uuid;
 begin
  perform public.adjust_member_points(admin,buyer,-8,'Attempt to remove held points',gen_random_uuid());
  raise exception 'adjustment spent reserved points';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'POINTS_LIMIT' then raise; end if;
 end;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_points_failed');
 perform public.apply_test_payment_event('evt_points_failed','checkout.session.async_payment_failed',true,
  checkout_id,'cs_live_points_failed',null,4850,'sgd');
 if public.read_member_points(buyer)->>'available' is distinct from '157' then
  raise exception 'failed payment should release no-coupon checkout holds';
 end if;
 result:=public.create_points_order(buyer,address,launch,false,null,null,0,null);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_test_points_simulated');
 perform public.apply_test_payment_event('evt_points_simulated','checkout.session.completed',false,
  checkout_id,'cs_test_points_simulated','pi_points_simulated',5000,'sgd');
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '157' or result->>'pending' is distinct from '0' then
  raise exception 'sandbox activity affected the formal balance: %',result;
 end if;
 if has_function_privilege('authenticated','public.read_member_points(uuid)','EXECUTE') or
    has_function_privilege('anon','public.quote_points_checkout(uuid,timestamptz,boolean,text,text,integer)','EXECUTE') or
    has_table_privilege('service_role','private.membership_point_ledger','INSERT') then
  raise exception 'points boundary opened to a direct API role';
 end if;
end $$;
rollback;
