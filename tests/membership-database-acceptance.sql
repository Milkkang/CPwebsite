-- Disposable database only. Synthetic formal orders never contact Stripe.
begin;
do $$
declare
 old_member uuid:=gen_random_uuid(); new_member uuid:=gen_random_uuid(); unverified uuid:=gen_random_uuid();
 address uuid:=gen_random_uuid(); new_address uuid:=gen_random_uuid();
 launch timestamptz:=now()-interval '5 hours'; verified timestamptz:=now()-interval '2 hours';
 result jsonb; checkout_id uuid;
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (old_member,'welcome-old@example.invalid',now()-interval '40 days'),
  (new_member,'welcome-new@example.invalid',verified),
  (unverified,'welcome-unverified@example.invalid',null);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values
  (address,old_member,'Synthetic','Synthetic','123456'),
  (new_address,new_member,'Synthetic','Synthetic','123456');
 result:=public.read_membership(old_member,launch,true);
 if result#>>'{welcome,status}' is distinct from 'available' or
    (result#>>'{welcome,expiresAt}')::timestamptz is distinct from launch+interval '720 hours' then
  raise exception 'existing member does not receive the 30-day launch window';
 end if;
 result:=public.read_membership(new_member,launch,true);
 if result#>>'{welcome,status}' is distinct from 'available' or
    (result#>>'{welcome,expiresAt}')::timestamptz is distinct from verified+interval '720 hours' then
  raise exception 'new member does not receive the 30-day verification window';
 end if;
 if public.read_membership(unverified,launch,true)->>'member' is distinct from 'false' or
    public.read_membership(old_member,now()+interval '1 hour',true)->>'enabled' is distinct from 'false' or
    public.read_membership(old_member,now()-interval '720 hours',true)#>>'{welcome,status}' is distinct from 'expired' then
  raise exception 'verification, activation, or exact expiry boundary failed';
 end if;
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('WELCOME-1','WELCOME-1','Welcome fixture','One','Fixture','acceptance','https://example.invalid/a.jpg',
  'https://example.invalid/a.jpg','https://example.invalid/a.jpg',2500,10,'Published');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active)
 values('welcome-test','SG',390,5000,true);
 insert into public.buyer_cart_items(user_id,sku,quantity) values(old_member,'WELCOME-1',1);
 begin
  perform public.quote_welcome_checkout(old_member,launch,true);
  raise exception 'welcome discount applied below merchandise minimum';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'WELCOME_MINIMUM' then raise; end if;
 end;
 update public.buyer_cart_items set quantity=2 where user_id=old_member;
 result:=public.quote_welcome_checkout(old_member,launch,true);
 if result->>'subtotal' is distinct from '5000' or result->>'discount' is distinct from '300' or
    result->>'shipping' is distinct from '0' or result->>'total' is distinct from '4700' then
  raise exception 'wrong quote for a S$50 basket';
 end if;
 begin
  perform public.create_welcome_order(new_member,address,launch,true,4700);
  raise exception 'cross-account address accepted';
 exception when sqlstate 'P0001' then
  if sqlerrm<>'ADDRESS_INVALID' then raise; end if;
 end;
 begin
  perform public.create_welcome_order(old_member,address,launch,true,4699);
  raise exception 'changed quote silently accepted';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'CART_CHANGED' then raise; end if;
 end;
 result:=public.create_welcome_order(old_member,address,launch,true,4700);
 checkout_id:=(result->>'id')::uuid;
 if result->>'total_cents' is distinct from '4700' or result->>'discount_cents' is distinct from '300' or
    public.read_membership(old_member,launch,true)#>>'{welcome,status}' is distinct from 'reserved' or
    public.read_membership(new_member,launch,true)#>>'{welcome,status}' is distinct from 'available' then
  raise exception 'order pricing or member isolation failed';
 end if;
 begin
  perform public.create_welcome_order(old_member,address,launch,true,4700);
  raise exception 'a second active reservation was accepted';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'CHECKOUT_PENDING' then raise; end if;
 end;
 perform public.attach_test_checkout(old_member,checkout_id,'cs_live_welcome_expiry');
 result:=public.apply_test_payment_event('evt_welcome_expired','checkout.session.expired',true,
  checkout_id,'cs_live_welcome_expiry',null,4700,'sgd');
 if result->>'outcome' is distinct from 'released' or
    public.read_membership(old_member,launch,true)#>>'{welcome,status}' is distinct from 'available' then
  raise exception 'expiry did not release the welcome reservation';
 end if;
 result:=public.create_welcome_order(old_member,address,launch,false,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(old_member,checkout_id,'cs_test_welcome_cancel');
 if public.read_pending_welcome_checkout(new_member) is not null or
    public.cancel_welcome_checkout(new_member,checkout_id,'cs_test_welcome_cancel') or
    public.cancel_welcome_checkout(old_member,checkout_id,'cs_test_wrong_session') or
    not public.cancel_welcome_checkout(old_member,checkout_id,'cs_test_welcome_cancel') then
  raise exception 'sandbox cancellation did not require an owned session';
 end if;
 if public.read_membership(old_member,launch,false)#>>'{welcome,status}' is distinct from 'available' then
  raise exception 'prepayment cancellation did not return the coupon';
 end if;
 result:=public.create_welcome_order(old_member,address,launch,false,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(old_member,checkout_id,'cs_test_welcome_failure');
 result:=public.apply_test_payment_event('evt_welcome_failed','checkout.session.async_payment_failed',false,
  checkout_id,'cs_test_welcome_failure',null,4700,'sgd');
 if result->>'outcome' is distinct from 'released' or
    public.read_membership(old_member,launch,false)#>>'{welcome,status}' is distinct from 'available' then
  raise exception 'payment failure did not return the coupon';
 end if;
 result:=public.create_welcome_order(old_member,address,launch,false,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(old_member,checkout_id,'cs_test_welcome_paid');
 result:=public.apply_test_payment_event('evt_welcome_test_paid','checkout.session.completed',false,
  checkout_id,'cs_test_welcome_paid','pi_test_welcome_paid',4700,'sgd');
 if result->>'outcome' is distinct from 'paid' or
    public.read_membership(old_member,launch,false)#>>'{welcome,status}' is distinct from 'used' or
    public.read_membership(old_member,launch,true)#>>'{welcome,status}' is distinct from 'available' then
  raise exception 'successful test redemption affected its own or formal coupon status incorrectly';
 end if;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,live_payment,payment_status)
 values(old_member,address,5000,0,0,5000,false,'paid'),
       (new_member,new_address,5000,0,0,5000,true,'refunded');
 if public.read_membership(old_member,launch,true)#>>'{welcome,status}' is distinct from 'available' or
    public.read_membership(new_member,launch,true)#>>'{welcome,status}' is distinct from 'ineligible' then
  raise exception 'sandbox and refunded formal payment history were not distinguished';
 end if;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,live_payment,payment_status)
 values(old_member,address,5000,0,0,5000,true,'paid');
 if public.read_membership(old_member,launch,true)#>>'{welcome,status}' is distinct from 'ineligible' then
  raise exception 'prior formal payment did not exclude the member';
 end if;
 insert into public.buyer_cart_items(user_id,sku,quantity) values(old_member,'WELCOME-1',2);
 -- Test actual formal settlement on a separate buyer with eligible history.
 delete from public.orders where user_id=new_member and payment_status='refunded';
 insert into public.buyer_cart_items(user_id,sku,quantity) values(new_member,'WELCOME-1',2);
 result:=public.create_welcome_order(new_member,new_address,launch,true,4700);
 checkout_id:=(result->>'id')::uuid;
 perform public.attach_test_checkout(new_member,checkout_id,'cs_live_welcome_paid');
 result:=public.apply_test_payment_event('evt_welcome_formal_paid','checkout.session.completed',true,
  checkout_id,'cs_live_welcome_paid','pi_welcome_paid',4700,'sgd');
 if result->>'outcome' is distinct from 'paid' then raise exception 'formal payment failed'; end if;
 result:=public.apply_test_payment_event('evt_welcome_formal_paid','checkout.session.completed',true,
  checkout_id,'cs_live_welcome_paid','pi_welcome_paid',4700,'sgd');
 if result->>'duplicate' is distinct from 'true' or
    public.read_membership(new_member,launch,true)#>>'{welcome,status}' is distinct from 'used' then
  raise exception 'formal payment retry repeated or lost the redemption';
 end if;
 begin
  perform public.quote_welcome_checkout(old_member,launch,true);
  raise exception 'paid buyer received another formal quote';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'WELCOME_UNAVAILABLE' then raise; end if;
 end;
 if has_function_privilege('anon','public.read_membership(uuid,timestamptz,boolean)','EXECUTE') or
    has_function_privilege('authenticated','public.read_membership(uuid,timestamptz,boolean)','EXECUTE') or
    has_function_privilege('authenticated','public.create_welcome_order(uuid,uuid,timestamptz,boolean,integer)','EXECUTE') or
    has_function_privilege('anon','public.quote_welcome_checkout(uuid,timestamptz,boolean)','EXECUTE') or
    has_function_privilege('anon','public.cancel_welcome_checkout(uuid,uuid,text)','EXECUTE') or
    has_table_privilege('authenticated','private.welcome_coupon_reservations','SELECT') or
    not has_function_privilege('service_role','public.read_membership(uuid,timestamptz,boolean)','EXECUTE') then
  raise exception 'member RPC privilege incorrect';
 end if;
end $$;
rollback;
