-- Seed historical orders before applying the delivery snapshot migration.
do $$
declare
 buyer uuid:='11111111-1111-4111-8111-111111111111';
 admin uuid:='22222222-2222-4222-8222-222222222222';
 saved uuid:='33333333-3333-4333-8333-333333333333';
 backup uuid:='44444444-4444-4444-8444-444444444444';
 edited uuid:='55555555-5555-4555-8555-555555555555';
 foreign_address uuid:='66666666-6666-4666-8666-666666666666';
begin
 insert into auth.users(id,email,email_confirmed_at) values
  (buyer,'delivery-buyer@example.invalid',now()),(admin,'delivery-admin@example.invalid',now());
 insert into public.admin_roles(user_id) values(admin);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code,created_at,updated_at) values
  (saved,buyer,'Original Recipient','Synthetic Street 1','001234',now()-interval '2 days',now()-interval '2 days'),
  (backup,buyer,'Backup Recipient','Synthetic Street 2','005678',now()-interval '1 day',now()-interval '1 day'),
  (edited,admin,'Earlier Recipient','Synthetic Street 3','003333',now()-interval '2 days',now()-interval '2 days'),
  (foreign_address,admin,'Unrelated Recipient','Synthetic Street 4','004444',now()-interval '2 days',now()-interval '2 days');
 insert into public.buyer_profiles(user_id,display_name,default_address_id) values(buyer,'Member Profile',saved);
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,payment_status) values
  (buyer,saved,1000,0,0,1000,'paid'),
  (admin,edited,1000,0,0,1000,'paid'),
  (buyer,foreign_address,1000,0,0,1000,'paid');
 update public.buyer_addresses set full_name='Later Recipient' where id=edited;
end $$;
