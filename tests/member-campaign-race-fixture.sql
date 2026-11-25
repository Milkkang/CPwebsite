-- The two buyers order distinct SKUs so shared stock cannot enforce the campaign cap.
insert into auth.users(id,email,email_confirmed_at) values
 ('b2c80d05-cbda-4ff2-9085-05691897c101','campaign-race-admin@example.invalid',now()),
 ('b2c80d05-cbda-4ff2-9085-05691897c102','campaign-race-1@example.invalid',now()),
 ('b2c80d05-cbda-4ff2-9085-05691897c103','campaign-race-2@example.invalid',now());
insert into public.admin_roles(user_id) values('b2c80d05-cbda-4ff2-9085-05691897c101');
insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code) values
 ('b2c80d05-cbda-4ff2-9085-05691897c104','b2c80d05-cbda-4ff2-9085-05691897c102','Synthetic','Synthetic','123456'),
 ('b2c80d05-cbda-4ff2-9085-05691897c105','b2c80d05-cbda-4ff2-9085-05691897c103','Synthetic','Synthetic','123456');
insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
select sku,sku,'Campaign fixture','One','Fixture','acceptance','https://example.invalid/a.jpg',
 'https://example.invalid/a.jpg','https://example.invalid/a.jpg',5000,10,'Published'
from (values ('CAMPAIGN-RACE-1'),('CAMPAIGN-RACE-2')) as fixtures(sku);
insert into public.buyer_cart_items(user_id,sku,quantity) values
 ('b2c80d05-cbda-4ff2-9085-05691897c102','CAMPAIGN-RACE-1',1),
 ('b2c80d05-cbda-4ff2-9085-05691897c103','CAMPAIGN-RACE-2',1);
select public.save_member_campaign('b2c80d05-cbda-4ff2-9085-05691897c101',null,0,jsonb_build_object(
 'title','Single slot','type','percent','amount',10,'minimum',5000,'startsAt',now()-interval '1 hour',
 'expiresAt',now()+interval '1 hour','audience','all','memberLimit',1,'totalLimit',1,'active',true))->>'id';
