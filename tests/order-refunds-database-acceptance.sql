begin;
do $$
<<order_refunds_test>>
declare
 owner uuid:=gen_random_uuid(); delivery_address uuid:=gen_random_uuid(); order_id uuid:=gen_random_uuid(); request uuid:=gen_random_uuid();
 result jsonb; current_version integer:=1;
begin
 insert into auth.users(id,email,email_confirmed_at) values(owner,'refund-acceptance@example.invalid',now());
 insert into public.admin_roles(user_id) values(owner);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(delivery_address,owner,'Synthetic','Synthetic','123456');
 insert into public.orders(id,user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
  payment_status,stripe_payment_intent_id)
 values(order_id,owner,delivery_address,100,50,50,100,'paid','pi_refund_legacy_rounding');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,status)
 values('REFUND-A','REFUND-A','Acceptance Item','One','Test','acceptance',
  'https://example.invalid/a','https://example.invalid/a','https://example.invalid/a',1,10,'Published'),
 ('REFUND-B','REFUND-B','Acceptance Item','Two','Test','acceptance',
  'https://example.invalid/b','https://example.invalid/b','https://example.invalid/b',71,10,'Published');
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity)
 values(order_id,'REFUND-A','Acceptance Item','One',1,29),(order_id,'REFUND-B','Acceptance Item','Two',71,1);

 result:=public.prepare_order_refund(owner,order_id,current_version,request,true,false,'[{"sku":"REFUND-A","quantity":1}]');
 if result->>'amount' is distinct from '1' then raise exception 'wrong first unit cash: %',result; end if;
 perform public.resolve_order_refund(owner,order_id,request,false,'re_failed_case','failed');
 if (select stock from public.products where id='REFUND-A')<>10 or
    (select version from public.orders where id=order_id)<>1 or
    (select refunded_quantity from public.order_items where order_items.order_id=order_refunds_test.order_id and sku='REFUND-A')<>0 then
  raise exception 'terminal Stripe failure applied a return';
 end if;
 result:=public.prepare_order_refund(owner,order_id,current_version,request,true,false,'[{"sku":"REFUND-A","quantity":1}]');
 if result->>'aborted' is distinct from 'true' then raise exception 'terminal failure did not remain idempotent'; end if;
 request:=gen_random_uuid();
 perform public.prepare_order_refund(owner,order_id,current_version,request,true,false,'[{"sku":"REFUND-A","quantity":1}]');
 begin
  perform public.prepare_order_refund(owner,order_id,current_version,request,true,false,'[{"sku":"REFUND-A","quantity":2}]');
  raise exception 'changed quantities accepted for the same request';
 exception when sqlstate 'PT409' then
  if sqlerrm<>'REFUND_REQUEST_CHANGED' then raise; end if;
 end;
 result:=public.resume_order_refund(owner,order_id,request,false);
 if result->>'completed' is distinct from 'false' or result->>'amount' is distinct from '1' then
  raise exception 'pending refund could not be resumed: %',result;
 end if;
 perform public.resolve_order_refund(owner,order_id,request,false,'re_first_cent','succeeded');
 current_version:=current_version+1;
 result:=public.resume_order_refund(owner,order_id,request,false);
 if result->>'completed' is distinct from 'true' or result->>'amount' is distinct from '1' or
    public.resume_order_refund(owner,gen_random_uuid(),request,false) is not null or
    public.resume_order_refund(owner,order_id,gen_random_uuid(),false) is not null then
  raise exception 'resume did not match the exact original refund: %',result;
 end if;
 request:=gen_random_uuid();
 result:=public.prepare_order_refund(owner,order_id,current_version,request,true,false,'[{"sku":"REFUND-A","quantity":1}]');
 if result->>'amount' is distinct from '0' then raise exception 'zero-cash unit is incorrect: %',result; end if;
 perform public.resolve_order_refund(owner,order_id,request,false,null,'no_cash');
 current_version:=current_version+1;
 if not exists(select 1 from public.inventory_movements where source_key='refund:'||request||':REFUND-A' and product_id='REFUND-A') then
  raise exception 'no-cash return needs the correct product ID and audit';
 end if;

 request:=gen_random_uuid();
 begin
  perform public.prepare_order_refund(owner,order_id,current_version,request,false,false,'[{"sku":"REFUND-A","quantity":28}]');
  raise exception 'quantity overage accepted';
 exception when invalid_parameter_value then
  if sqlerrm<>'REFUND_QUANTITY_UNAVAILABLE' then raise; end if;
 end;
 result:=public.prepare_order_refund(owner,order_id,current_version,request,false,false,'[{"sku":"REFUND-A","quantity":27}]');
 if result->>'amount' is distinct from '14' then raise exception 'legacy checkout float rounding was not preserved: %',result; end if;
 perform public.resolve_order_refund(owner,order_id,request,false,'re_remaining_legacy_line','succeeded');
 current_version:=current_version+1;
 request:=gen_random_uuid();
 result:=public.prepare_order_refund(owner,order_id,current_version,request,true,false,null);
 if result->>'amount' is distinct from '85' then raise exception 'final refund should include the 50 cents delivery: %',result; end if;
 perform public.resolve_order_refund(owner,order_id,request,false,'re_legacy_shipping','succeeded');
 if not exists(select 1 from public.orders where id=order_id and payment_status='refunded' and
   refunded_cents=100 and refunded_merchandise_cents=50 and fulfilment_status='Cancelled') or
   (select stock from public.products where id='REFUND-A')<>12 or
   (select stock from public.products where id='REFUND-B')<>11 then
  raise exception 'legacy order and stock did not match all partial returns and final closure';
 end if;
 -- Refunding all original cash does not close an order with a free gift still outstanding.
 order_id:=gen_random_uuid();
 insert into public.orders(id,user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,
  payment_status,stripe_payment_intent_id)
 values(order_id,owner,delivery_address,50,0,0,50,'paid','pi_refund_no_shipping');
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity)
 values(order_id,'REFUND-A','Acceptance Item','Gift',0,1),(order_id,'REFUND-B','Acceptance Item','Paid',50,1);
 request:=gen_random_uuid();
 perform public.prepare_order_refund(owner,order_id,1,request,false,false,'[{"sku":"REFUND-B","quantity":1}]');
 perform public.resolve_order_refund(owner,order_id,request,false,'re_all_cash','succeeded');
 if not exists(select 1 from public.orders where id=order_id and payment_status='paid' and refunded_cents=50) then
  raise exception 'order closed while a free item remained unreturned';
 end if;
 request:=gen_random_uuid();
 perform public.prepare_order_refund(owner,order_id,2,request,false,false,'[{"sku":"REFUND-A","quantity":1}]');
 perform public.resolve_order_refund(owner,order_id,request,false,null,'no_cash');
 if not exists(select 1 from public.orders where id=order_id and payment_status='refunded' and refunded_cents=50
    and fulfilment_status='Cancelled') then
  raise exception 'final item return did not close an entirely refunded order';
 end if;
 if has_function_privilege('authenticated','public.prepare_order_refund(uuid,uuid,integer,uuid,boolean,boolean,jsonb)','EXECUTE') or
    has_function_privilege('authenticated','public.resume_order_refund(uuid,uuid,uuid,boolean)','EXECUTE') or
    has_function_privilege('anon','public.resolve_order_refund(uuid,uuid,uuid,boolean,text,text)','EXECUTE') or
    has_table_privilege('service_role','private.order_refunds','INSERT') then
  raise exception 'refund operation access leaked outside its server boundary';
 end if;
end $$;
rollback;
