-- Disposable database only. These assertions never use production users or stock.
do $$
declare u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); a uuid:=gen_random_uuid();
 o uuid; pending_order uuid; op jsonb; n integer; before_stock integer;
begin
 insert into auth.users(id,email,email_confirmed_at) values(u,'phase7@example.invalid',now()),(outsider,'outsider@example.invalid',now());
 insert into public.admin_roles(user_id) values(u);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values(a,u,'Synthetic','Synthetic','123456');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('OP-1','OP-1','Operation fixture','One','Fixture','acceptance','https://example.invalid/a.jpg','https://example.invalid/a.jpg','https://example.invalid/a.jpg',1000,10,'Published');
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status,stripe_payment_intent_id)
 values(u,a,2000,0,0,2000,'paid','pi_test_operations') returning id into o;
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity) values(o,'OP-1','Operation fixture','One',1000,2);
 begin
  perform public.prepare_test_order_operation(outsider,o,1,'refund',true);raise exception 'non-admin accepted';
 exception when insufficient_privilege then null;end;
 begin
  perform public.prepare_test_order_operation(u,o,999,'refund',true);raise exception 'stale version accepted';
 exception when serialization_failure then null;end;
 op:=public.prepare_test_order_operation(u,o,1,'refund',true);
 if (op->>'amount')::integer<>2000 or (op->>'completed')::boolean then raise exception 'invalid preparation';end if;
 begin
  perform public.admin_update_order(u,o,1,'Shipped','TRACK');raise exception 'shipment raced refund';
 exception when serialization_failure then null;end;
 begin
  perform public.prepare_test_order_operation(u,o,1,'refund',false);raise exception 'retry changed restock';
 exception when invalid_parameter_value then null;end;
 perform public.finish_test_order_operation(u,o,'refund','re_test_operations');
 perform public.finish_test_order_operation(u,o,'refund','re_test_operations');
 if (select stock from public.products where sku='OP-1')<>12 then raise exception 'refund stock incorrect or doubled';end if;
 if (select count(*) from public.inventory_movements where source_key='refund:'||o||':OP-1')<>1 then raise exception 'refund ledger duplicated';end if;
 if (select count(*) from public.email_jobs where order_id=o and kind='test_refund')<>1 then raise exception 'refund email missing or duplicated';end if;
 if (select payment_status from public.orders where id=o)<>'refunded' then raise exception 'refund not recorded';end if;
 op:=public.prepare_test_order_operation(u,o,1,'refund',true);
 if not (op->>'completed')::boolean then raise exception 'completed retry not recognized';end if;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id)
 values(u,a,2000,0,0,2000,'cs_test_operation_cancel') returning id into pending_order;
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity) values(pending_order,'OP-1','Operation fixture','One',1000,2);
 update public.products set reserved_quantity=2 where sku='OP-1';
 perform public.prepare_test_order_operation(u,pending_order,1,'cancel',false);
 perform public.finish_test_order_operation(u,pending_order,'cancel','cs_test_operation_cancel');
 perform public.finish_test_order_operation(u,pending_order,'cancel','cs_test_operation_cancel');
 if (select reserved_quantity from public.products where sku='OP-1')<>0 or (select stock from public.products where sku='OP-1')<>12 then raise exception 'cancellation stock corrupted';end if;
 -- The signed Stripe expiry can win the race while the admin cancellation waits for Stripe.
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id)
 values(u,a,2000,0,0,2000,'cs_test_cancel_expiry_race') returning id into pending_order;
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity) values(pending_order,'OP-1','Operation fixture','One',1000,2);
 update public.products set reserved_quantity=2 where sku='OP-1';
 perform public.prepare_test_order_operation(u,pending_order,1,'cancel',false);
 op:=public.apply_test_payment_event('evt_test_cancel_expiry_race','checkout.session.expired',false,
  pending_order,'cs_test_cancel_expiry_race',null,2000,'sgd');
 if op->>'outcome' is distinct from 'released' then raise exception 'expiry did not win cancellation race: %',op; end if;
 begin
  perform public.finish_test_order_operation(u,pending_order,'cancel','cs_test_wrong_cancel_expiry');
  raise exception 'cancellation accepted an unrelated Stripe session';
 exception when serialization_failure then null;
 end;
 if not public.finish_test_order_operation(u,pending_order,'cancel','cs_test_cancel_expiry_race') or
    not public.finish_test_order_operation(u,pending_order,'cancel','cs_test_cancel_expiry_race') then
  raise exception 'matching expiry did not complete cancellation idempotently';
 end if;
 if (select reserved_quantity from public.products where sku='OP-1')<>0 or
    (select count(*) from public.email_jobs where order_id=pending_order and kind='cancellation')<>1 then
  raise exception 'matching expiry repeated cancellation side effects';
 end if;
 -- A failing second import row must roll back the first row and stock ledger.
 select stock into before_stock from public.products where sku='OP-1';
 begin
  perform public.admin_import_products(u,jsonb_build_array(
   jsonb_build_object('sku','OP-1','version',(select version from public.products where sku='OP-1'),'fields','{}'::jsonb,'stock',99),
   jsonb_build_object('sku','ZZ-INVALID','version',0,'fields','{}'::jsonb,'stock',1)));
  raise exception 'invalid import committed';
 exception when not_null_violation then null;end;
 if (select stock from public.products where sku='OP-1')<>before_stock then raise exception 'partial import leaked';end if;
 if has_function_privilege('anon','public.prepare_test_order_operation(uuid,uuid,integer,text,boolean)','EXECUTE') or
    has_function_privilege('authenticated','public.finish_test_order_operation(uuid,uuid,text,text)','EXECUTE') or
    has_table_privilege('anon','public.order_operations','SELECT') then raise exception 'operation privilege leaked';end if;
end $$;

-- Search aggregation and receipt ownership use the same service-only boundary.
do $$
declare u uuid; other uuid; a uuid; o uuid;
begin
 select id into u from auth.users where email='phase7@example.invalid';
 select id into other from auth.users where email='outsider@example.invalid';
 select id into a from public.buyer_addresses where user_id=u limit 1;
 if not public.record_catalog_search('Acceptance term',0,repeat('a',64)) or not public.record_catalog_search('acceptance term',2,repeat('a',64)) then raise exception 'search not recorded';end if;
 if (select searches from public.catalog_search_counts where term='acceptance term')<>2 or (select misses from public.catalog_search_counts where term='acceptance term')<>1 then raise exception 'search aggregation incorrect';end if;
 if public.record_catalog_search('private@example.invalid',0,repeat('a',64)) then raise exception 'email-like query collected';end if;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status,fulfilment_status)
 values(u,a,1000,0,0,1000,'paid','Shipped') returning id into o;
 if public.confirm_test_order_receipt(other,o,1) or public.confirm_test_order_receipt(u,o,999) then raise exception 'receipt owner or version bypass';end if;
 if not public.confirm_test_order_receipt(u,o,1) or public.confirm_test_order_receipt(u,o,1) then raise exception 'receipt invalid or repeated';end if;
 if (select count(*) from public.email_jobs where order_id=o and kind='delivery')<>1 then raise exception 'receipt delivery notice missing';end if;
end $$;

create function public.reject_test_refund_email() returns trigger language plpgsql as $$
begin
 if new.kind='test_refund' then raise exception 'synthetic refund email failure';end if;
 return new;
end $$;
create trigger reject_test_refund_email before insert on public.email_jobs for each row execute function public.reject_test_refund_email();
do $$
declare u uuid; a uuid; o uuid;
begin
 select id into u from auth.users where email='phase7@example.invalid';
 select id into a from public.buyer_addresses where user_id=u limit 1;
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status,stripe_payment_intent_id)
 values(u,a,1000,0,0,1000,'paid','pi_test_refund_mail_failure') returning id into o;
 perform public.prepare_test_order_operation(u,o,1,'refund',false);
 perform public.finish_test_order_operation(u,o,'refund','re_test_mail_failure');
 if (select payment_status from public.orders where id=o)<>'refunded' then raise exception 'mail failure undid refund';end if;
 if not exists(select 1 from public.email_confirmation_outbox where order_id=o and kind='test_refund' and enqueued_at is null and last_error_code is not null) then raise exception 'refund notice lost';end if;
end $$;
drop trigger reject_test_refund_email on public.email_jobs;
select public.reconcile_email_confirmations(25);
do $$
begin
 if exists(select 1 from public.email_confirmation_outbox where kind='test_refund' and enqueued_at is null) then raise exception 'refund notice did not recover';end if;
end $$;

-- A QA admin needs both service-managed grants; revocation is checked per request.
do $$
declare u uuid; sid uuid:=gen_random_uuid(); result jsonb;
begin
 select id into u from auth.users where email='phase7@example.invalid';
 insert into auth.sessions(id,user_id) values(sid,u);
 insert into public.server_sessions(session_hash,user_id,auth_session_id,access_token_encrypted,recovery_only,expires_at)
 values(repeat('b',64),u,sid,'synthetic-encrypted-fixture',false,now()+interval '1 hour');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.resolve_web_session(repeat('b',64));
 if (result->>'isAdmin')::boolean then raise exception 'unapproved extra admin session';end if;
 insert into public.buyer_profiles(user_id,checkout_email) values(u,'pay@example.invalid')
  on conflict(user_id) do update set checkout_email=excluded.checkout_email;
 result:=public.resolve_web_session(repeat('b',64));
 if result#>>'{account,checkoutEmail}' is distinct from 'pay@example.invalid'
   or result#>>'{account,email}' is distinct from 'phase7@example.invalid' then
  raise exception 'checkout email changed the sign-in identity or was not returned';
 end if;
 insert into public.checkout_testers(user_id) values(u);
 result:=public.resolve_web_session(repeat('b',64));
 if not (result->>'isAdmin')::boolean then raise exception 'explicit QA admin not recognized';end if;
 update public.checkout_testers set enabled=false where user_id=u;
 result:=public.resolve_web_session(repeat('b',64));
 if (result->>'isAdmin')::boolean then raise exception 'QA admin revocation ignored';end if;
end $$;

begin;
do $$
declare
 buyer uuid:=gen_random_uuid();
 admin uuid:=gen_random_uuid();
 first_order uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
 second_order uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
 address uuid:=gen_random_uuid();
 shipments jsonb:=jsonb_build_array(
   jsonb_build_object('id',first_order,'version',1,'tracking','TRACK-ONE'),
   jsonb_build_object('id',second_order,'version',1,'tracking','TRACK-TWO'));
 deliveries jsonb:=jsonb_build_array(
   jsonb_build_object('id',first_order,'version',2),
   jsonb_build_object('id',second_order,'version',2));
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (buyer,'bulk-buyer@example.invalid',now()),(admin,'bulk-admin@example.invalid',now());
 insert into public.admin_roles(user_id) values(admin);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(address,buyer,'Synthetic','Synthetic','123456');
 insert into public.orders(id,user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status) values
  (first_order,buyer,address,1000,0,0,1000,'paid'),
  (second_order,buyer,address,1000,0,0,1000,'paid');
 if has_function_privilege('anon','public.admin_bulk_ship_orders(uuid,jsonb)','EXECUTE') or
    has_function_privilege('authenticated','public.admin_bulk_ship_orders(uuid,jsonb)','EXECUTE') then
  raise exception 'bulk shipping is callable by an application role';
 end if;

 set local role service_role;
 begin
  perform public.admin_bulk_ship_orders(buyer,shipments);
  raise exception 'bulk shipping accepted a non-admin actor';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.admin_bulk_ship_orders(admin,jsonb_set(shipments,'{1,version}','2'));
  raise exception 'bulk shipping accepted a stale order version';
 exception when serialization_failure then null;
 end;
 reset role;
 if exists(select 1 from public.orders where id in (first_order,second_order) and fulfilment_status<>'Processing')
    or exists(select 1 from public.email_jobs where order_id in (first_order,second_order) and kind='shipment') then
  raise exception 'a stale batch partially shipped orders or queued email';
 end if;

 set local role service_role;
 if public.admin_bulk_ship_orders(admin,shipments)<>2 then
  raise exception 'bulk shipping returned an unexpected count';
 end if;
 begin
  perform public.admin_bulk_ship_orders(admin,jsonb_set(shipments,'{0,version}','2'));
  raise exception 'bulk shipping accepted an order that was already shipped';
 exception when serialization_failure then null;
 end;
 reset role;
 if (select count(*) from public.orders where fulfilment_status='Shipped' and version=2
      and ((id=first_order and tracking_number='TRACK-ONE') or (id=second_order and tracking_number='TRACK-TWO')))<>2
    or (select count(*) from public.email_jobs where order_id in (first_order,second_order) and kind='shipment')<>2 then
  raise exception 'bulk shipping did not preserve per-order tracking and shipment email';
 end if;
 if has_function_privilege('anon','public.admin_bulk_deliver_orders(uuid,jsonb)','EXECUTE') or
    has_function_privilege('authenticated','public.admin_bulk_deliver_orders(uuid,jsonb)','EXECUTE') then
  raise exception 'bulk delivery is callable by an application role';
 end if;
 set local role service_role;
 begin
  perform public.admin_bulk_deliver_orders(buyer,deliveries);
  raise exception 'bulk delivery accepted a non-admin actor';
 exception when insufficient_privilege then null;
 end;
 begin
  perform public.admin_bulk_deliver_orders(admin,jsonb_set(deliveries,'{1,version}','1'));
  raise exception 'bulk delivery accepted a stale order version';
 exception when serialization_failure then null;
 end;
 reset role;
 if exists(select 1 from public.orders where id in (first_order,second_order) and fulfilment_status<>'Shipped')
    or exists(select 1 from public.email_jobs where order_id in (first_order,second_order) and kind='delivery') then
  raise exception 'a stale batch partially marked orders delivered or queued email';
 end if;

 set local role service_role;
 if public.admin_bulk_deliver_orders(admin,deliveries)<>2 then
  raise exception 'bulk delivery returned an unexpected count';
 end if;
 begin
  perform public.admin_bulk_deliver_orders(admin,deliveries);
  raise exception 'bulk delivery accepted a duplicate request';
 exception when serialization_failure then null;
 end;
 reset role;
 if (select count(*) from public.orders where fulfilment_status='Delivered' and version=3
      and ((id=first_order and tracking_number='TRACK-ONE') or (id=second_order and tracking_number='TRACK-TWO')))<>2
    or (select count(*) from public.email_jobs where order_id in (first_order,second_order) and kind='delivery')<>2 then
  raise exception 'bulk delivery did not preserve tracking and queue exactly one email per order';
 end if;
end $$;
rollback;

begin;
do $$
declare buyer uuid:=gen_random_uuid(); addr uuid:=gen_random_uuid(); new_order uuid; simulated uuid; result jsonb; order_version integer;
begin
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents) values('live-fixture','SG',390,5000);
 insert into auth.users(id,email,email_confirmed_at) values(buyer,'live-buyer@example.invalid',now());
 insert into public.admin_roles(user_id) values(buyer);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(addr,buyer,'Delivery name','Synthetic Road','123456');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,min_quantity,status)
 values('LIVE-1','LIVE-1','Fixture','One','Fixture','acceptance','https://example.invalid/a.jpg','https://example.invalid/a.jpg','https://example.invalid/a.jpg',1000,10,1,'Published');
 insert into public.buyer_cart_items(user_id,sku,quantity) values(buyer,'LIVE-1',2);
 result:=public.create_live_order(buyer,addr,null);
 new_order:=(result->>'id')::uuid;
 if (result->>'live_payment')::boolean is distinct from true then raise exception 'Live order not classified'; end if;
 begin
  perform public.create_live_order(buyer,addr,null);
  raise exception 'Duplicate pending order';
 exception when sqlstate 'PT409' then null;
 end;
 if not public.attach_test_checkout(buyer,new_order,'cs_live_fixture') then raise exception 'Session not attached'; end if;
 begin
  perform public.apply_test_payment_event('evt_wrong_mode','checkout.session.completed',false,new_order,'cs_live_fixture','pi_live_fixture',(result->>'total_cents')::integer,'sgd');
  raise exception 'Wrong mode accepted';
 exception when invalid_parameter_value then null;
 end;
 begin
  perform public.apply_test_payment_event('evt_wrong_total','checkout.session.completed',true,new_order,'cs_live_fixture','pi_live_fixture',50,'sgd');
  raise exception 'Wrong total accepted';
 exception when invalid_parameter_value then null;
 end;
 update public.buyer_cart_items set quantity=3 where user_id=buyer and sku='LIVE-1';
 perform public.apply_test_payment_event('evt_live_paid','checkout.session.completed',true,new_order,'cs_live_fixture','pi_live_fixture',(result->>'total_cents')::integer,'sgd');
 perform public.apply_test_payment_event('evt_live_paid','checkout.session.completed',true,new_order,'cs_live_fixture','pi_live_fixture',(result->>'total_cents')::integer,'sgd');
 if (select stock from public.products where sku='LIVE-1')<>8 or
  (select reserved_quantity from public.products where sku='LIVE-1')<>0 or
  (select quantity from public.buyer_cart_items where user_id=buyer and sku='LIVE-1')<>3 then
  raise exception 'Payment did not commit stock exactly once or damaged the changed cart';
 end if;
 select version into order_version from public.orders where id=new_order;
 perform public.admin_update_order(buyer,new_order,order_version,'Shipped','LIVE-TRACK');
 select version into order_version from public.orders where id=new_order;
 perform public.admin_update_order(buyer,new_order,order_version,'Delivered','LIVE-TRACK');
 select version into order_version from public.orders where id=new_order;
 perform public.prepare_order_operation(buyer,new_order,order_version,'refund',true,true);
 perform public.finish_test_order_operation(buyer,new_order,'refund','re_live_fixture');
 if (select stock from public.products where sku='LIVE-1')<>10 then raise exception 'Live refund did not restore stock'; end if;
 if (select count(*) from public.email_jobs where order_id=new_order and not is_test and recipient='live-buyer@example.invalid')<>5 then
  raise exception 'Live notifications were not queued correctly';
 end if;
 result:=public.create_live_order(buyer,addr,null);
 if not public.attach_test_checkout(buyer,(result->>'id')::uuid,'cs_live_cancel') then raise exception 'Cancellation session not attached'; end if;
 if not public.cancel_live_checkout(buyer,(result->>'id')::uuid,'cs_live_cancel') or
    not public.cancel_live_checkout(buyer,(result->>'id')::uuid,'cs_live_cancel') then raise exception 'Cancel did not reconcile'; end if;
 if (select count(*) from public.email_jobs where order_id=(result->>'id')::uuid and kind='cancellation' and not is_test)<>1 then
  raise exception 'Live cancellation email missing or duplicated';
 end if;
 insert into public.coupons(code,kind,amount,minimum_cents,active) values('QA-COUPON','fixed',100,0,true);
 simulated:=(public.create_test_order(buyer,addr,'QA-COUPON')->>'id')::uuid;
 update public.coupons set active=false,deleted_at=now() where code='QA-COUPON' and version=1 and deleted_at is null;
 if not exists(select 1 from public.coupons where code='QA-COUPON' and not active and deleted_at is not null and version=2)
   or not exists(select 1 from public.orders where id=simulated and coupon_code='QA-COUPON' and discount_cents=100) then
  raise exception 'Coupon deletion changed historical order details or failed to bump the version';
 end if;
 begin
  update public.coupons set active=true where code='QA-COUPON';
  raise exception 'Deleted coupon was reactivated';
 exception when check_violation then null;
 end;
 begin
  perform public.create_test_order(buyer,addr,'QA-COUPON');
  raise exception 'Test checkout accepted a deleted coupon';
 exception when raise_exception then
  if sqlerrm<>'COUPON_INVALID' then raise; end if;
 end;
 begin
  perform public.create_live_order(buyer,addr,'QA-COUPON');
  raise exception 'Live checkout accepted a deleted coupon';
 exception when raise_exception then
  if sqlerrm<>'COUPON_INVALID' then raise; end if;
 end;
 begin
  perform public.apply_test_payment_event('evt_sim_live','checkout.session.completed',true,simulated,'cs_live_fixture','pi_live_fixture',50,'sgd');
  raise exception 'Live event was applied to simulation';
 exception when invalid_parameter_value then null;
 end;
 delete from public.buyer_addresses where user_id=buyer and id=addr;
 if not exists(select 1 from private.order_delivery_addresses where order_id=new_order and full_name='Delivery name') then
  raise exception 'Order delivery snapshot lost';
 end if;
end $$;
rollback;
