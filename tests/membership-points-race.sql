-- A shared 100-point balance cannot cover both a checkout and an admin debit.
insert into auth.users(id,email,email_confirmed_at) values
 ('eddbf692-e993-46a7-90d4-23052bce0010','points-race-owner@example.invalid',now()-interval '1 day'),
 ('eddbf692-e993-46a7-90d4-23052bce0011','points-race-buyer@example.invalid',now()-interval '1 day');
insert into public.admin_roles(user_id) values('eddbf692-e993-46a7-90d4-23052bce0010');
insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
values('eddbf692-e993-46a7-90d4-23052bce0012','eddbf692-e993-46a7-90d4-23052bce0011','Synthetic','Synthetic','123456');
insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
values ('POINTS-RACE','POINTS-RACE','Points fixture','Race','Fixture','acceptance','https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',1000,10,'Published');
insert into public.buyer_cart_items(user_id,sku,quantity) values('eddbf692-e993-46a7-90d4-23052bce0011','POINTS-RACE',1);
select public.adjust_member_points('eddbf692-e993-46a7-90d4-23052bce0010',
 'eddbf692-e993-46a7-90d4-23052bce0011',100,'Opening balance',gen_random_uuid());
