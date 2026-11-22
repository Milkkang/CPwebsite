-- Run after the incremental migration in a disposable PostgreSQL database.
do $$
declare
 buyer uuid:='11111111-1111-4111-8111-111111111111';
 admin uuid:='22222222-2222-4222-8222-222222222222';
 saved uuid:='33333333-3333-4333-8333-333333333333';
 backup uuid:='44444444-4444-4444-8444-444444444444';
 foreign_address uuid:='66666666-6666-4666-8666-666666666666';
 order_row jsonb;
 addresses jsonb;
 replacement uuid;
 invalid_address uuid;
 new_order jsonb;
 paid jsonb;
 shipped jsonb;
begin
 if public.change_member_address(admin,'delete',saved) is not null or
    public.change_member_address(admin,'default',backup) is not null then
  raise exception 'another account could change the buyer address book';
 end if;
 if public.change_member_address(buyer,'delete',saved) is distinct from '{"ok":true}'::jsonb then
  raise exception 'buyer could not delete their used default address';
 end if;
 addresses:=public.read_member_addresses(buyer);
 if jsonb_array_length(addresses)<>1 or (addresses->0->>'id') is distinct from backup::text or
    (addresses->0->>'is_default') is distinct from 'true' then
  raise exception 'the remaining checkout address did not become the default';
 end if;
 select item into order_row from jsonb_array_elements(public.read_admin_orders(admin)) item where item->>'number'='CVM-1000';
 if (order_row->>'full_name',order_row->>'address_line',order_row->>'postal_code',order_row->>'customer_name')
    is distinct from ('Original Recipient','Synthetic Street 1','001234','Member Profile') then
  raise exception 'migrated order lost delivery data after address removal';
 end if;
 shipped:=public.admin_update_order(admin,(order_row->>'id')::uuid,(order_row->>'version')::integer,'Shipped','LEGACY-DELIVERY');
 if shipped->>'tracking_number' is distinct from 'LEGACY-DELIVERY' then
  raise exception 'migrated order could not ship after address removal';
 end if;

 if (select count(*) from jsonb_array_elements(public.read_admin_orders(admin)) item
     where item->>'number' in ('CVM-1001','CVM-1002') and item->>'full_name' is null
       and item->>'address_line' is null and item->>'postal_code' is null)<>2 then
  raise exception 'historical orders with unreliable addresses were hidden or assigned unverified delivery details';
 end if;
 begin
  perform public.read_admin_orders(buyer);
  raise exception 'delivery data was available to a non-admin';
 exception when insufficient_privilege then null;
 end;

 insert into public.categories(id,name) values('delivery-test','Delivery test category');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('DELIVERY-1','DELIVERY-1','Delivery fixture','One','Fixture','delivery-test',
  'https://example.invalid/a.jpg','https://example.invalid/a.jpg','https://example.invalid/a.jpg',1000,10,'Published');
 insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents) values('delivery-test','SG',0,0);
 perform public.set_member_cart(buyer,'DELIVERY-1',1);

 foreach invalid_address in array array[saved,foreign_address] loop
  begin
   perform public.create_test_order(buyer,invalid_address);
   raise exception 'checkout accepted a removed or another account address';
  exception when raise_exception then
   if sqlerrm<>'ADDRESS_INVALID' then raise; end if;
  end;
 end loop;

 new_order:=public.create_test_order(buyer,backup);
 if not public.attach_test_checkout(buyer,(new_order->>'id')::uuid,'cs_test_order_delivery') then
  raise exception 'checkout could not start for a current address';
 end if;
 update public.buyer_addresses set full_name='Changed Recipient',address_line='Changed Street',postal_code='009999' where id=backup;
 replacement:=(public.change_member_address(buyer,'create',null,
  '{"full_name":"New Recipient","address_line":"Synthetic Street 5","postal_code":"005555"}')->>'id')::uuid;
 if public.change_member_address(buyer,'default',replacement) is distinct from '{"ok":true}'::jsonb or
    public.change_member_address(buyer,'delete',backup) is distinct from '{"ok":true}'::jsonb then
  raise exception 'buyer could not replace and remove a new order address';
 end if;
 addresses:=public.read_member_addresses(buyer);
 if jsonb_array_length(addresses)<>1 or (addresses->0->>'id') is distinct from replacement::text or
    (addresses->0->>'is_default') is distinct from 'true' then
  raise exception 'the current address was not the only choice after removal';
 end if;

 paid:=public.apply_test_payment_event('evt_order_delivery','checkout.session.completed',false,
  (new_order->>'id')::uuid,'cs_test_order_delivery','pi_test_order_delivery',1000,'sgd');
 if paid->>'outcome' is distinct from 'paid' then raise exception 'payment failed after address removal'; end if;
 select item into order_row from jsonb_array_elements(public.read_admin_orders(admin)) item where item->>'id'=new_order->>'id';
 if (order_row->>'full_name',order_row->>'address_line',order_row->>'postal_code')
    is distinct from ('Backup Recipient','Synthetic Street 2','005678') then
  raise exception 'new order delivery information changed when its address was edited and removed';
 end if;
 shipped:=public.admin_update_order(admin,(order_row->>'id')::uuid,(order_row->>'version')::integer,'Shipped','NEW-DELIVERY');
 if not public.confirm_test_order_receipt(buyer,(shipped->>'id')::uuid,(shipped->>'version')::integer) then
  raise exception 'buyer could not receive an order after removing its delivery address';
 end if;
 select item into order_row from jsonb_array_elements(public.read_admin_orders(admin)) item where item->>'number'='CVM-1000';
 if (order_row->>'full_name',order_row->>'address_line',order_row->>'postal_code',order_row->>'fulfilment_status')
    is distinct from ('Original Recipient','Synthetic Street 1','001234','Shipped') then
  raise exception 'new address activity changed a migrated order';
 end if;

 if has_function_privilege('anon','public.read_admin_orders(uuid)','EXECUTE') or
    has_function_privilege('authenticated','public.read_admin_orders(uuid)','EXECUTE') or
    not has_function_privilege('service_role','public.read_admin_orders(uuid)','EXECUTE') then
  raise exception 'admin order read privileges changed';
 end if;
 if exists(
  select 1 from unnest(array['anon','authenticated','service_role']) role_name
  where has_table_privilege(role_name,'private.order_delivery_addresses','SELECT,INSERT,UPDATE,DELETE')
 ) then
  raise exception 'application roles can access delivery snapshots directly';
 end if;
end $$;
