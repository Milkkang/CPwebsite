insert into auth.users(id,email,email_confirmed_at)
 values('6e5ee724-c805-4f65-a051-20de63f3c201','refund-race@example.invalid',now());
insert into public.admin_roles(user_id) values('6e5ee724-c805-4f65-a051-20de63f3c201');
insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values('6e5ee724-c805-4f65-a051-20de63f3c202','6e5ee724-c805-4f65-a051-20de63f3c201','Synthetic','Synthetic','123456');
insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('REFUND-RACE','REFUND-RACE','Refund race','One','Fixture','acceptance',
  'https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',1000,10,'Published');
insert into public.orders(id,user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status,stripe_payment_intent_id)
 values('6e5ee724-c805-4f65-a051-20de63f3c203','6e5ee724-c805-4f65-a051-20de63f3c201','6e5ee724-c805-4f65-a051-20de63f3c202',
  2000,0,0,2000,'paid','pi_refund_race');
insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity)
 values('6e5ee724-c805-4f65-a051-20de63f3c203','REFUND-RACE','Refund race','One',1000,2);
