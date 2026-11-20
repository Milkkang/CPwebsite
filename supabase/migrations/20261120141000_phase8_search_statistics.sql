create table public.catalog_search_counts(
 term text primary key check(length(term) between 1 and 120),
 searches bigint not null default 0, misses bigint not null default 0, updated_at timestamptz not null default now()
);
alter table public.catalog_search_counts enable row level security;
revoke all on public.catalog_search_counts from public,anon,authenticated;
grant all on public.catalog_search_counts to service_role;
create function public.record_catalog_search(p_term text,p_results integer,p_key text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare search_term text:=lower(trim(p_term));
begin
 if search_term is null or length(search_term) not between 1 and 120 or search_term~'[[:cntrl:]@]' or p_results is null or p_results<0 then return false;end if;
 if not public.consume_auth_limit(p_key,60,3600) then return false;end if;
 insert into public.catalog_search_counts(term,searches,misses) values(search_term,1,case when p_results=0 then 1 else 0 end)
 on conflict(term) do update set searches=public.catalog_search_counts.searches+1,
 misses=public.catalog_search_counts.misses+excluded.misses,updated_at=now();
 return true;
end $$;
revoke all on function public.record_catalog_search(text,integer,text) from public,anon,authenticated;
grant execute on function public.record_catalog_search(text,integer,text) to service_role;

-- Delayed test payments fulfil only after the paid provider event.
create or replace function public.apply_test_payment_event(p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; outcome text; job uuid; kind public.email_job_kind;
begin
 perform pg_advisory_xact_lock(hashtextextended('stripe:'||p_event,0));
 if exists(select 1 from public.stripe_webhook_events where event_id=p_event) then return jsonb_build_object('duplicate',true); end if;
 if p_livemode is distinct from false then raise exception using errcode='P0001',message='LIVE_MODE_REJECTED'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then outcome:='order_not_found';
 elsif p_type in ('checkout.session.completed','checkout.session.async_payment_succeeded') then
  if o.payment_status<>'pending' or o.stripe_checkout_session_id is distinct from p_session or o.total_cents is distinct from p_amount or p_currency is distinct from 'sgd' then outcome:='payment_mismatch';
  else
   perform 1 from public.products p join public.order_items i on i.sku=p.sku where i.order_id=o.id order by p.sku for update of p;
   insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key)
    select p.id,p.stock,-i.quantity,p.stock-i.quantity,'stripe_test_payment','stripe:'||p_event||':'||p.id from public.order_items i join public.products p on p.sku=i.sku where i.order_id=o.id;
   update public.products p set stock=p.stock-i.quantity,reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
    from public.order_items i where i.order_id=o.id and i.sku=p.sku and p.stock>=i.quantity;
   update public.orders set payment_status='paid',stripe_payment_intent_id=nullif(p_intent,''),paid_at=now(),updated_at=now(),version=version+1 where id=o.id;
   delete from public.buyer_cart_items where user_id=o.user_id; outcome:='paid';
   kind:='order_confirmation';
  end if;
 elsif p_type in ('checkout.session.expired','checkout.session.async_payment_failed') then
  if o.payment_status<>'pending' or o.stripe_checkout_session_id is distinct from p_session or o.total_cents is distinct from p_amount or p_currency is distinct from 'sgd' then outcome:='payment_mismatch';
  elsif public.release_test_order(o.id) then outcome:='released'; kind:='cancellation';
  else outcome:='release_failed'; end if;
 else outcome:='ignored'; end if;
 if kind is not null then
  insert into public.email_confirmation_outbox(event_id,order_id,kind) values(p_event,o.id,kind);
  begin
   job:=public.enqueue_order_email(o.id,kind,'stripe/'||p_event);
   if job is not null then
    update public.email_confirmation_outbox set enqueued_at=now() where event_id=p_event;
   else
    update public.email_confirmation_outbox set last_error_code='NO_RECIPIENT' where event_id=p_event;
   end if;
  exception when others then
   update public.email_confirmation_outbox set last_error_code=sqlstate where event_id=p_event;
  end;
 end if;
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

-- Lock listing prices and stock before calculating and reserving a checkout.
create or replace function public.create_test_order(p_user uuid,p_address uuid,p_coupon text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; a public.buyer_addresses; delivery public.delivery_rules; coupon public.coupons;
 subtotal integer; shipping integer; discount integer:=0; item_count integer; reserved_count integer;
begin
 select * into a from public.buyer_addresses where id=p_address and user_id=p_user;
 if not found then raise exception using errcode='P0001',message='ADDRESS_INVALID'; end if;
 select * into delivery from public.delivery_rules where country_code='SG' and active order by id limit 1;
 if not found then raise exception using errcode='P0001',message='DELIVERY_UNAVAILABLE'; end if;
 perform 1 from public.products p join public.buyer_cart_items c on c.sku=p.sku where c.user_id=p_user order by p.sku for update of p;
 select count(*),coalesce(sum(p.price_cents*c.quantity),0) into item_count,subtotal
 from public.buyer_cart_items c join public.products p on p.sku=c.sku
 where c.user_id=p_user and p.status='Published' and c.quantity>=p.min_quantity and c.quantity<=p.available_quantity;
 if item_count=0 or item_count<>(select count(*) from public.buyer_cart_items where user_id=p_user) then
   raise exception using errcode='P0001',message='CART_CHANGED';
 end if;
 shipping:=case when subtotal>=delivery.free_threshold_cents then 0 else delivery.shipping_cents end;
 if nullif(trim(p_coupon),'') is not null then
   select * into coupon from public.coupons where code=upper(trim(p_coupon)) and active;
   if not found or subtotal<coupon.minimum_cents then raise exception using errcode='P0001',message='COUPON_INVALID'; end if;
   if coupon.kind='shipping' then shipping:=0;
   elsif coupon.kind='fixed' then discount:=least(subtotal,coupon.amount);
   else discount:=round(subtotal*coupon.amount/100.0); end if;
 end if;
 discount:=least(discount,subtotal+shipping-50);
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,coupon_code)
 values(p_user,p_address,subtotal,shipping,discount,subtotal+shipping-discount,coupon.code) returning * into o;
 insert into public.order_items(order_id,sku,product_name,variant_name,image_url,unit_cents,quantity)
 select o.id,p.sku,p.name,p.variant_name,p.image_url,p.price_cents,c.quantity
 from public.buyer_cart_items c join public.products p on p.sku=c.sku where c.user_id=p_user;
 update public.products p set reserved_quantity=p.reserved_quantity+i.quantity,version=version+1
 from public.order_items i where i.order_id=o.id and p.sku=i.sku and p.available_quantity>=i.quantity;
 get diagnostics reserved_count=row_count;
 if reserved_count<>item_count then
   raise exception using errcode='P0001',message='CART_CHANGED';
 end if;
 return public.read_order_json(o.id,p_user);
end $$;

create function public.confirm_test_order_receipt(p_user uuid,p_order uuid,p_version integer)
returns boolean language plpgsql security invoker set search_path='' as $$
declare new_version integer;
begin
 update public.orders set fulfilment_status='Delivered',version=version+1,updated_at=now()
 where id=p_order and user_id=p_user and version=p_version and payment_status='paid' and fulfilment_status='Shipped' returning version into new_version;
 if not found then return false;end if;
 perform public.queue_test_order_notice(p_order,'delivery','receipt/'||p_order||'/version/'||new_version);
 return true;
end $$;
revoke all on function public.confirm_test_order_receipt(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.confirm_test_order_receipt(uuid,uuid,integer) to service_role;

create or replace function public.admin_update_order(p_actor uuid,p_order uuid,p_version integer,p_status public.order_fulfilment_status,p_tracking text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; previous public.order_fulfilment_status;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order and version=p_version and payment_status='paid' for update;
 if not found then raise exception using errcode='40001'; end if; previous:=o.fulfilment_status;
 if p_status='Cancelled' or (o.fulfilment_status='Processing' and p_status not in ('Processing','Shipped')) or
  (o.fulfilment_status='Shipped' and p_status not in ('Shipped','Delivered')) or o.fulfilment_status='Delivered' and p_status<>'Delivered' then raise exception using errcode='P0001',message='INVALID_TRANSITION'; end if;
 if p_status='Shipped' and nullif(trim(p_tracking),'') is null then raise exception using errcode='P0001',message='TRACKING_REQUIRED'; end if;
 update public.orders set fulfilment_status=p_status,tracking_number=case when p_status='Processing' then '' else left(trim(p_tracking),120) end,
  updated_at=now(),version=version+1 where id=p_order returning * into o;
 if previous='Processing' and p_status='Shipped' then perform public.queue_test_order_notice(o.id,'shipment','order/'||o.id||'/version/'||o.version); end if;
 if previous='Shipped' and p_status='Delivered' then perform public.queue_test_order_notice(o.id,'delivery','order/'||o.id||'/version/'||o.version); end if;
 return public.read_order_json(o.id,null);
end $$;
