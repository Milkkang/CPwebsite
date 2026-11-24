-- Isolated checkout, signed payment effects, and admin read/write boundaries.
begin;
do $$
declare
 actor uuid:=gen_random_uuid(); buyer uuid:=gen_random_uuid(); newcomer uuid:=gen_random_uuid();
 unverified uuid:=gen_random_uuid(); address uuid:=gen_random_uuid(); new_address uuid:=gen_random_uuid();
 campaign uuid; checkout_id uuid; result jsonb;
 launch timestamptz:=now()-interval '1 day'; config jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (actor,'campaign-admin@example.invalid',launch),(buyer,'campaign-buyer@example.invalid',launch),
  (newcomer,'campaign-new@example.invalid',launch),(unverified,'campaign-unverified@example.invalid',null);
 insert into public.admin_roles(user_id) values(actor);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values
  (address,buyer,'Synthetic','Synthetic','123456'),(new_address,newcomer,'Synthetic','Synthetic','123456');
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,live_payment,payment_status)
 values(buyer,address,5000,0,0,5000,true,'refunded');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('CAMPAIGN-1','CAMPAIGN-1','Campaign fixture','One','Fixture','acceptance','https://example.invalid/a.jpg',
  'https://example.invalid/a.jpg','https://example.invalid/a.jpg',2500,30,'Published');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active)
 values('campaign-test','SG',390,5000,true);
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'CAMPAIGN-1',1),(newcomer,'CAMPAIGN-1',2);
 config:=jsonb_build_object('title','Returning buyer discount','type','fixed','amount',300,'minimum',5000,
  'startsAt',launch,'expiresAt',now()+interval '1 day','audience','returning','memberLimit',1,'totalLimit',1,'active',true);
 begin
  perform public.save_member_campaign(buyer,null,0,config);
  raise exception 'buyer edited admin campaigns';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.read_member_campaigns(buyer);
  raise exception 'buyer read admin campaigns';
 exception when insufficient_privilege then null;
 end;
 result:=public.save_member_campaign(actor,null,0,config);
 campaign:=(result->>'id')::uuid;
 if result->>'version' is distinct from '1' or result->>'redeemed' is distinct from '0' then
  raise exception 'admin cannot see current campaign and zero redemptions';
 end if;
 if public.read_membership(buyer,launch,true)#>>'{campaigns,0,id}' is distinct from campaign::text or
    public.read_membership(buyer,launch,true)#>>'{welcome,status}' is distinct from 'ineligible' or
    public.read_membership(newcomer,launch,true)->'campaigns' is distinct from '[]'::jsonb or
    public.read_membership(unverified,launch,true)->'campaigns' is distinct from '[]'::jsonb then
  raise exception 'returning campaign was not scoped to eligible verified accounts';
 end if;
 begin
  perform public.quote_campaign_checkout(newcomer,campaign,launch,true);
  raise exception 'an ineligible buyer quoted a campaign';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'CAMPAIGN_UNAVAILABLE' then raise; end if;
 end;
 begin
  perform public.quote_campaign_checkout(buyer,campaign,launch,true);
  raise exception 'the discount bypassed the product subtotal minimum';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'CAMPAIGN_MINIMUM' then raise; end if;
 end;
 update public.buyer_cart_items set quantity=2 where user_id=buyer;
 result:=public.quote_campaign_checkout(buyer,campaign,launch,true);
 if result->>'total' is distinct from '4700' then raise exception 'campaign quote is incorrect'; end if;
 result:=public.create_campaign_order(buyer,address,campaign,launch,true,4700);
 checkout_id:=(result->>'id')::uuid;
 if public.read_membership(buyer,launch,true)->'campaigns' is distinct from '[]'::jsonb then
  raise exception 'reserved places remained available';
 end if;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_campaign_failure');
 result:=public.apply_test_payment_event('evt_campaign_failure','checkout.session.async_payment_failed',true,
  checkout_id,'cs_live_campaign_failure',null,4700,'sgd');
 if result->>'outcome' is distinct from 'released' or
    public.read_membership(buyer,launch,true)#>>'{campaigns,0,id}' is distinct from campaign::text then
  raise exception 'failed payment did not release its campaign reservation';
 end if;
 result:=public.create_campaign_order(buyer,address,campaign,launch,true,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_live_campaign_paid');
 result:=public.apply_test_payment_event('evt_campaign_paid','checkout.session.completed',true,
  checkout_id,'cs_live_campaign_paid','pi_campaign_paid',4700,'sgd');
 if result->>'outcome' is distinct from 'paid' then raise exception 'campaign payment did not settle'; end if;
 result:=public.apply_test_payment_event('evt_campaign_paid','checkout.session.completed',true,
  checkout_id,'cs_live_campaign_paid','pi_campaign_paid',4700,'sgd');
 if result->>'duplicate' is distinct from 'true' or public.read_member_campaigns(actor)#>>'{0,redeemed}' is distinct from '1' or
    public.read_member_campaigns(actor)#>>'{0,testRedeemed}' is distinct from '0' then
  raise exception 'admin campaign redemption count did not settle exactly once';
 end if;
 if public.read_membership(buyer,launch,false)#>>'{campaigns,0,id}' is distinct from campaign::text then
  raise exception 'formal and sandbox caps were not isolated';
 end if;
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'CAMPAIGN-1',2);
 result:=public.create_campaign_order(buyer,address,campaign,launch,false,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(buyer,checkout_id,'cs_test_campaign_cancel');
 if public.read_pending_welcome_checkout(buyer)->>'id' is distinct from checkout_id::text or
    public.cancel_welcome_checkout(newcomer,checkout_id,'cs_test_campaign_cancel') is distinct from false or
    public.cancel_welcome_checkout(buyer,checkout_id,'cs_test_campaign_cancel') is distinct from true or
    public.read_membership(buyer,launch,false)#>>'{campaigns,0,id}' is distinct from campaign::text then
  raise exception 'sandbox campaign cancellation did not release the owned order';
 end if;
 result:=public.create_campaign_order(buyer,address,campaign,launch,false,4700);
 checkout_id:=(result->>'id')::uuid;
 update private.member_campaign_redemptions set reserved_at=now()-interval '6 minutes' where order_id=checkout_id;
 if public.release_stale_member_campaign_order() is distinct from true or
    public.read_membership(buyer,launch,false)#>>'{campaigns,0,id}' is distinct from campaign::text then
  raise exception 'an interrupted checkout kept a shared campaign place indefinitely';
 end if;
 result:=public.save_member_campaign(actor,campaign,1,config||'{"active":false}');
 if result->>'active' is distinct from 'false' or result->>'version' is distinct from '2' or
    public.read_membership(buyer,launch,false)->'campaigns' is distinct from '[]'::jsonb then
  raise exception 'pausing a campaign did not remove availability';
 end if;
 result:=public.save_member_campaign(actor,campaign,2,config||'{"totalLimit":3,"audience":"all"}');
 if result->>'version' is distinct from '3' or
    public.read_membership(buyer,launch,true)->'campaigns' is distinct from '[]'::jsonb or
    public.read_membership(newcomer,launch,true)#>>'{campaigns,0,id}' is distinct from campaign::text then
  raise exception 'the exhausted per-member cap blocked another buyer or opened the coupon for the same buyer';
 end if;
 if has_function_privilege('authenticated','public.save_member_campaign(uuid,uuid,integer,jsonb)','EXECUTE') or
    has_function_privilege('anon','public.read_member_campaigns(uuid)','EXECUTE') or
    has_function_privilege('authenticated','public.create_campaign_order(uuid,uuid,uuid,timestamptz,boolean,integer)','EXECUTE') or
    has_table_privilege('authenticated','private.member_campaign_redemptions','SELECT') then
  raise exception 'campaign administration or reservation is directly accessible';
 end if;
end $$;
rollback;
