-- Synthetic formal checkouts exercise the deployed SQL boundaries without Stripe.
begin;
do $$
declare
 buyer uuid:=gen_random_uuid(); other_buyer uuid:=gen_random_uuid(); admin uuid:=gen_random_uuid();
 address uuid:=gen_random_uuid(); checkout_id uuid; campaign uuid; credited_order uuid; expired_credit_order uuid; debt_address uuid:=gen_random_uuid();
 release_by_expiry boolean; replacement uuid;
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
 credited_order:=checkout_id;
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
 result:=public.prepare_order_refund(admin,checkout_id,(select version from public.orders where id=checkout_id),
  reversal,true,true,'[{"sku":"POINTS-A","quantity":1}]');
 if result->>'amount' is distinct from '1800' or result->>'paidAmount' is distinct from '4500' or
    result->>'earned' is distinct from '18' or result->>'restored' is distinct from '80' then
  raise exception 'refund must use the original cash and points allocation: %',result;
 end if;
 if (select stock from public.products where sku='POINTS-A')<>9 or
    (select refunded_cents from public.orders where id=checkout_id)<>0 then
  raise exception 'preparing a refund must not restock or record it as completed';
 end if;
 perform public.resolve_order_refund(admin,checkout_id,reversal,true,'re_points_fixture','succeeded');
 perform public.resolve_order_refund(admin,checkout_id,reversal,true,'re_points_fixture','succeeded');
 if (select stock from public.products where sku='POINTS-A')<>10 or
    (select stock from public.products where sku='POINTS-B')<>9 or
    (select refunded_quantity from public.order_items where order_id=checkout_id and sku='POINTS-A')<>1 or
    not exists(select 1 from public.orders where id=checkout_id and refunded_cents=1800 and
      refunded_merchandise_cents=1800 and payment_status='paid' and fulfilment_status='Delivered') then
  raise exception 'partial refund, inventory or order state is incorrect';
 end if;
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '157' or result->>'expiring' is distinct from '80' then
  raise exception 'refund must preserve restored points and revoke the points originally credited by that order: %',result;
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
 -- Bring forward an order's unused earn-lot expiry without changing the other lots.
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'POINTS-A',1);
 result:=public.create_points_order(buyer,address,launch,true,null,null,0,null);
 expired_credit_order:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,expired_credit_order,'cs_live_points_unused_credit');
 perform public.apply_test_payment_event('evt_points_unused_credit','checkout.session.completed',true,
  expired_credit_order,'cs_live_points_unused_credit','pi_points_unused_credit',2390,'sgd');
 perform public.admin_update_order(admin,expired_credit_order,(select version from public.orders where id=expired_credit_order),'Shipped','Synthetic');
 if not public.confirm_test_order_receipt(buyer,expired_credit_order,(select version from public.orders where id=expired_credit_order)) then
  raise exception 'buyer receipt failed on the unused-earn order';
 end if;
 if public.read_member_points(buyer)->>'available' is distinct from '177' then
  raise exception 'the earned lot should contain 20 unused points before expiry';
 end if;
 update private.membership_point_lots set expires_at=now()-interval '1 day' where user_id=buyer and issued=20;
 perform private.apply_membership_points_refund(expired_credit_order,gen_random_uuid(),20,'[]');
 result:=public.read_member_points(buyer);
 if result->>'available' is distinct from '157' or result->>'debt' is distinct from '0' then
  raise exception 'expired unused earnings must not deduct unrelated points or create debt: %',result;
 end if;
 -- The original earn lot is completely held by the next checkout. A second
 -- return must use newly restored spendable points without raiding that hold.
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'POINTS-A',1),(buyer,'POINTS-B',1);
 result:=public.create_points_order(buyer,address,launch,true,null,null,157,4843);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_points_next_checkout');
 reversal:=gen_random_uuid();
 result:=public.prepare_order_refund(admin,credited_order,(select version from public.orders where id=credited_order),
  reversal,true,true,null);
 if result->>'amount' is distinct from '2700' or result->>'earned' is distinct from '27' or
    result->>'restored' is distinct from '120' then raise exception 'wrong full refund remainder: %',result; end if;
 perform public.resolve_order_refund(admin,credited_order,reversal,true,'re_points_full_fixture','succeeded');
 if not exists(select 1 from public.orders where id=credited_order and payment_status='refunded' and
   fulfilment_status='Cancelled' and refunded_cents=4500 and refunded_merchandise_cents=4500) or
   exists(select 1 from public.order_items where order_id=credited_order and refunded_quantity<>quantity) or
   (select count(*) from public.inventory_movements where source_key in
    ('refund:'||reversal||':POINTS-A','refund:'||reversal||':POINTS-B'))<>1 then
  raise exception 'full refund after partial did not close the order or restocked twice';
 end if;
 result:=public.apply_test_payment_event('evt_points_next_checkout','checkout.session.completed',true,
  checkout_id,'cs_live_points_next_checkout','pi_points_next_checkout',4843,'sgd');
 if result->>'outcome' is distinct from 'paid' then raise exception 'points held by the open checkout could not settle'; end if;
 if public.read_member_points(buyer)->>'available' is distinct from '93' then
  raise exception 'already-held points or the restored balance was lost';
 end if;
 reversal:=gen_random_uuid();
 result:=public.prepare_order_refund(admin,checkout_id,(select version from public.orders where id=checkout_id),
  reversal,false,true,'[{"sku":"POINTS-A","quantity":1}]');
 if result->>'amount' is distinct from '1937' or result->>'earned' is distinct from '19' then
  raise exception 'wrong original cash or earning for pre-delivery return: %',result;
 end if;
 perform public.resolve_order_refund(admin,checkout_id,reversal,true,'re_points_pre_delivery','succeeded');
 if public.read_member_points(buyer)->>'pending' is distinct from '29' then
  raise exception 'pre-delivery return must reduce pending points';
 end if;
 -- A credited lot is held by a later pending checkout when its earning order is refunded.
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(debt_address,other_buyer,'Synthetic','Synthetic','123456');
 for release_by_expiry in select unnest(array[true,false]) loop
  insert into public.buyer_cart_items(user_id,sku,quantity) values(other_buyer,'POINTS-B',5);
  credited_order:=(public.create_points_order(other_buyer,debt_address,launch,true,null,null,0,15000)->>'id')::uuid;
  perform public.attach_test_checkout(other_buyer,credited_order,'cs_live_points_debt_earning_'||release_by_expiry);
  perform public.apply_test_payment_event('evt_points_debt_earning_'||release_by_expiry,'checkout.session.completed',true,
   credited_order,'cs_live_points_debt_earning_'||release_by_expiry,'pi_points_debt_earning_'||release_by_expiry,15000,'sgd');
  perform public.admin_update_order(admin,credited_order,(select version from public.orders where id=credited_order),'Shipped','Synthetic');
  perform public.confirm_test_order_receipt(other_buyer,credited_order,(select version from public.orders where id=credited_order));
  insert into public.buyer_cart_items(user_id,sku,quantity) values(other_buyer,'POINTS-B',1);
  checkout_id:=(public.create_points_order(other_buyer,debt_address,launch,true,null,null,100,3290)->>'id')::uuid;
  if release_by_expiry then perform public.attach_test_checkout(other_buyer,checkout_id,'cs_live_points_debt_hold'); end if;
  reversal:=gen_random_uuid();
  perform public.prepare_order_refund(admin,credited_order,(select version from public.orders where id=credited_order),
   reversal,true,true,null);
  perform public.resolve_order_refund(admin,credited_order,reversal,true,'re_points_debt_earning_'||release_by_expiry,'succeeded');
  result:=public.read_member_points(other_buyer);
  if result->>'available' is distinct from '0' or result->>'debt' is distinct from '100' then
   raise exception 'refund took the open checkout hold or lost its debt: %',result;
  end if;
  if release_by_expiry then
   perform public.apply_test_payment_event('evt_points_debt_hold_expired','checkout.session.expired',true,
    checkout_id,'cs_live_points_debt_hold',null,3290,'sgd');
  else
   -- A replacement checkout can contain different SKUs from the old one.
   update public.orders set created_at=now()-interval '6 minutes' where id=checkout_id;
   delete from public.buyer_cart_items where user_id=other_buyer;
   insert into public.buyer_cart_items(user_id,sku,quantity) values(other_buyer,'POINTS-A',1);
   replacement:=(public.create_live_order(other_buyer,debt_address,null)->>'id')::uuid;
   if (select payment_status from public.orders where id=checkout_id) is distinct from 'failed' or
      not exists(select 1 from public.order_items where order_id=replacement and sku='POINTS-A') then
    raise exception 'replacement checkout did not release the old order and reserve the new cart';
   end if;
   perform public.release_test_order(replacement);
  end if;
  result:=public.read_member_points(other_buyer);
  if result->>'available' is distinct from '0' or result->>'debt' is distinct from '0' or
     result#>>'{ledger,0,kind}' is distinct from 'debt_repaid' or result#>>'{ledger,0,points}' is distinct from '-100' then
   raise exception 'released held points must repay the refund debt before becoming spendable: %',result;
  end if;
  begin
   perform public.create_points_order(other_buyer,debt_address,launch,true,null,null,100,
    case when release_by_expiry then 3290 else 2290 end);
   raise exception 'a new checkout could spend revoked points';
  exception when sqlstate 'PT409' then
   if sqlerrm<>'POINTS_LIMIT' then raise; end if;
  end;
  delete from public.buyer_cart_items where user_id=other_buyer;
 end loop;
 if has_function_privilege('authenticated','public.read_member_points(uuid)','EXECUTE') or
    has_function_privilege('anon','public.quote_points_checkout(uuid,timestamptz,boolean,text,text,integer)','EXECUTE') or
    has_table_privilege('service_role','private.membership_point_ledger','INSERT') then
  raise exception 'points boundary opened to a direct API role';
 end if;
end $$;
rollback;
