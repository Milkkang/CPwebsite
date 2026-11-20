-- Disposable database only: make order 1005 a paid, delivered test order.
select setval(pg_get_serial_sequence('public.orders','order_number'),1004,true);
with buyer as (
 insert into auth.users(email,email_confirmed_at) values('acceptance@example.invalid',now()) returning id
), address as (
 insert into public.buyer_addresses(user_id,full_name,address_line,postal_code)
 select id,'Acceptance User','Test Street 1','123456' from buyer returning id,user_id
), placed as (
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
  payment_status,fulfilment_status,stripe_checkout_session_id,paid_at)
 select user_id,id,1000,0,0,1000,'paid','Delivered','cs_test_backfill',now() from address returning id,user_id
)
insert into public.email_jobs(order_id,kind,recipient,recipient_hash,is_test,idempotency_key,status,provider_message_id)
select id,'shipment','acceptance@example.invalid',public.email_recipient_hash('acceptance@example.invalid'),true,
 'shipment/fixture/1005','delivered','synthetic-shipment-1005' from placed;
