-- Synthetic Stripe-test order only. No Stripe API call, email or real address. Entire test rolls back.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('55555555-5555-4555-8555-555555555551','phase5-buyer@example.invalid',now()),
 ('55555555-5555-4555-8555-555555555552','phase5-admin@example.invalid',now());
insert into public.buyer_profiles(user_id,display_name) values
 ('55555555-5555-4555-8555-555555555551','Phase 5 Buyer'),('55555555-5555-4555-8555-555555555552','Phase 5 Admin');
insert into public.admin_roles(user_id) values('55555555-5555-4555-8555-555555555552');
insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values
 ('66666666-6666-4666-8666-666666666661','55555555-5555-4555-8555-555555555551','Synthetic Buyer','Synthetic address','000001');

set local role service_role;
do $$declare sku_value text; qty integer; before_stock integer; order_json jsonb; order_id uuid; paid jsonb; duplicate jsonb;begin
 select id,min_quantity,stock into sku_value,qty,before_stock from public.products where status='Published' and available_quantity>=min_quantity order by id limit 1;
 assert sku_value is not null,'published fixture product';
 insert into public.buyer_cart_items(user_id,sku,quantity) values('55555555-5555-4555-8555-555555555551',sku_value,qty);
 order_json:=public.create_test_order('55555555-5555-4555-8555-555555555551','66666666-6666-4666-8666-666666666661',null);
 order_id:=(order_json->>'id')::uuid;
 assert order_json->>'payment_status'='pending','pending order';
 assert public.attach_test_checkout('55555555-5555-4555-8555-555555555551',order_id,'cs_test_phase5')=true,'session attach';
 paid:=public.apply_test_payment_event('evt_test_phase5','checkout.session.completed',false,order_id,'cs_test_phase5','pi_test_phase5',(order_json->>'total_cents')::integer,'sgd');
 assert paid->>'outcome'='paid','payment applied';
 assert (select payment_status='paid' and stripe_payment_intent_id='pi_test_phase5' from public.orders where id=order_id),'paid state';
 assert (select stock=before_stock-qty and reserved_quantity>=0 from public.products where id=sku_value),'stock committed once';
 assert not exists(select 1 from public.buyer_cart_items where user_id='55555555-5555-4555-8555-555555555551'),'cart cleared';
 duplicate:=public.apply_test_payment_event('evt_test_phase5','checkout.session.completed',false,order_id,'cs_test_phase5','pi_test_phase5',(order_json->>'total_cents')::integer,'sgd');
 assert (duplicate->>'duplicate')::boolean,'event idempotent';
 assert (select stock=before_stock-qty from public.products where id=sku_value),'duplicate did not decrement stock';
 assert public.read_admin_orders('55555555-5555-4555-8555-555555555552') @> '[{"email":"phase5-buyer@example.invalid"}]'::jsonb,'admin order visibility';
end $$;
reset role;

set local role authenticated;
do $$begin
 begin perform 1 from public.orders;raise exception 'member can read orders directly';exception when insufficient_privilege then null;end;
 begin perform public.create_test_order('55555555-5555-4555-8555-555555555551','66666666-6666-4666-8666-666666666661',null);raise exception 'member can create order RPC';exception when insufficient_privilege then null;end;
 begin perform public.apply_test_payment_event('fake','checkout.session.completed',false,gen_random_uuid(),'','',0,'sgd');raise exception 'member can forge payment';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
select 'PASS: server totals, test payment, stock ledger, cart clear, webhook idempotency, admin visibility, direct/RPC denial; fixtures rolled back' as result;
