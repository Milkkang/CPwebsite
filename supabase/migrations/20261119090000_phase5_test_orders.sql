-- Phase 5 test checkout. Stripe remains test-mode only; no live transaction data belongs here.
create type public.order_payment_status as enum ('pending','paid','expired','failed','refunded');
create type public.order_fulfilment_status as enum ('Processing','Shipped','Delivered','Cancelled');

create table public.orders (
  id uuid primary key default gen_random_uuid(), order_number bigint generated always as identity (start with 1000),
  user_id uuid not null references auth.users(id), address_id uuid not null references public.buyer_addresses(id),
  currency text not null default 'sgd' check (currency='sgd'), subtotal_cents integer not null check (subtotal_cents>=0),
  shipping_cents integer not null check (shipping_cents>=0), discount_cents integer not null check (discount_cents>=0),
  total_cents integer not null check (total_cents=subtotal_cents+shipping_cents-discount_cents and total_cents>=50),
  coupon_code text references public.coupons(code), payment_status public.order_payment_status not null default 'pending',
  fulfilment_status public.order_fulfilment_status not null default 'Processing', tracking_number text not null default '',
  stripe_checkout_session_id text unique, stripe_payment_intent_id text unique,
  paid_at timestamptz, expires_at timestamptz not null default (now()+interval '30 minutes'),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), version integer not null default 1,
  unique (id,user_id)
);
create table public.order_items (
  order_id uuid not null references public.orders(id) on delete cascade, sku text not null references public.products(sku),
  product_name text not null, variant_name text not null, image_url text not null default '', unit_cents integer not null check(unit_cents>=0),
  quantity integer not null check(quantity>0), primary key(order_id,sku)
);
create table public.stripe_webhook_events (
  event_id text primary key, event_type text not null, livemode boolean not null,
  processed_at timestamptz not null default now(), order_id uuid references public.orders(id), outcome text not null
);
create index orders_user_created_idx on public.orders(user_id,created_at desc);
create index orders_payment_idx on public.orders(payment_status,created_at desc);
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.stripe_webhook_events enable row level security;

create or replace function public.read_order_json(p_order uuid,p_user uuid default null)
returns jsonb language sql security definer set search_path=public stable as $$
 select to_jsonb(o)-'user_id'-'address_id'-'stripe_checkout_session_id'-'stripe_payment_intent_id'||jsonb_build_object(
  'number','CVM-'||o.order_number,'items',coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.sku) from public.order_items i where i.order_id=o.id),'[]'::jsonb))
 from public.orders o where o.id=p_order and (p_user is null or o.user_id=p_user)
$$;

create or replace function public.create_test_order(p_user uuid,p_address uuid,p_coupon text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; a public.buyer_addresses; delivery public.delivery_rules; coupon public.coupons;
 subtotal integer; shipping integer; discount integer:=0; item_count integer; reserved_count integer;
begin
 select * into a from public.buyer_addresses where id=p_address and user_id=p_user;
 if not found then raise exception using errcode='P0001',message='ADDRESS_INVALID'; end if;
 select * into delivery from public.delivery_rules where country_code='SG' and active order by id limit 1;
 if not found then raise exception using errcode='P0001',message='DELIVERY_UNAVAILABLE'; end if;
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

create or replace function public.attach_test_checkout(p_user uuid,p_order uuid,p_session text)
returns boolean language plpgsql security definer set search_path=public as $$
begin update public.orders set stripe_checkout_session_id=p_session,updated_at=now(),version=version+1
 where id=p_order and user_id=p_user and payment_status='pending' and stripe_checkout_session_id is null;
 return found; end $$;

create or replace function public.release_test_order(p_order uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.orders where id=p_order and payment_status='pending' for update) then return false; end if;
 update public.products p set reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
 from public.order_items i where i.order_id=p_order and i.sku=p.sku;
 update public.orders set payment_status='failed',fulfilment_status='Cancelled',updated_at=now(),version=version+1 where id=p_order;
 return true;
end $$;

create or replace function public.apply_test_payment_event(p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; outcome text;
begin
 if exists(select 1 from public.stripe_webhook_events where event_id=p_event) then return jsonb_build_object('duplicate',true); end if;
 if p_livemode then raise exception using errcode='P0001',message='LIVE_MODE_REJECTED'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then outcome:='order_not_found';
 elsif p_type='checkout.session.completed' then
   if o.payment_status<>'pending' or o.stripe_checkout_session_id<>p_session or o.total_cents<>p_amount or p_currency<>'sgd' then outcome:='payment_mismatch';
   else
    insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key)
      select p.id,p.stock,-i.quantity,p.stock-i.quantity,'stripe_test_payment','stripe:'||p_event||':'||p.id
      from public.order_items i join public.products p on p.sku=i.sku where i.order_id=o.id;
    update public.products p set stock=p.stock-i.quantity,reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
      from public.order_items i where i.order_id=o.id and i.sku=p.sku and p.stock>=i.quantity;
    update public.orders set payment_status='paid',stripe_payment_intent_id=nullif(p_intent,''),paid_at=now(),updated_at=now(),version=version+1 where id=o.id;
    delete from public.buyer_cart_items where user_id=o.user_id; outcome:='paid';
   end if;
 elsif p_type in ('checkout.session.expired','checkout.session.async_payment_failed') then
   perform public.release_test_order(o.id); outcome:='released';
 else outcome:='ignored'; end if;
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

create or replace function public.read_admin_orders(p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public,auth stable as $$
declare result jsonb;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into result from (
  select o.id,'CVM-'||o.order_number as number,u.email,coalesce(p.display_name,'') as customer_name,
   a.full_name,a.address_line,a.postal_code,o.payment_status,o.fulfilment_status,o.tracking_number,
   o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.created_at,o.paid_at,o.version,
   coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.sku) from public.order_items i where i.order_id=o.id),'[]'::jsonb) items
  from public.orders o join auth.users u on u.id=o.user_id left join public.buyer_profiles p on p.user_id=o.user_id
  join public.buyer_addresses a on a.id=o.address_id
 ) x;
 return result;
end $$;

create or replace function public.admin_update_order(p_actor uuid,p_order uuid,p_version integer,p_status public.order_fulfilment_status,p_tracking text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order and version=p_version and payment_status='paid' for update;
 if not found then raise exception using errcode='40001'; end if;
 if p_status='Cancelled' or (o.fulfilment_status='Processing' and p_status not in ('Processing','Shipped')) or
   (o.fulfilment_status='Shipped' and p_status not in ('Shipped','Delivered')) or o.fulfilment_status='Delivered' and p_status<>'Delivered' then
   raise exception using errcode='P0001',message='INVALID_TRANSITION';
 end if;
 if p_status='Shipped' and nullif(trim(p_tracking),'') is null then raise exception using errcode='P0001',message='TRACKING_REQUIRED'; end if;
 update public.orders set fulfilment_status=p_status,tracking_number=case when p_status='Processing' then '' else left(trim(p_tracking),120) end,
  updated_at=now(),version=version+1 where id=p_order returning * into o;
 return public.read_order_json(o.id,null);
end $$;

revoke all on public.orders,public.order_items,public.stripe_webhook_events from anon,authenticated;
revoke all on function public.create_test_order(uuid,uuid,text),public.read_order_json(uuid,uuid),public.attach_test_checkout(uuid,uuid,text),public.release_test_order(uuid),public.apply_test_payment_event(text,text,boolean,uuid,text,text,integer,text),public.read_admin_orders(uuid),public.admin_update_order(uuid,uuid,integer,public.order_fulfilment_status,text) from public,anon,authenticated;
grant execute on function public.create_test_order(uuid,uuid,text),public.read_order_json(uuid,uuid),public.attach_test_checkout(uuid,uuid,text),public.release_test_order(uuid),public.apply_test_payment_event(text,text,boolean,uuid,text,text,integer,text),public.read_admin_orders(uuid),public.admin_update_order(uuid,uuid,integer,public.order_fulfilment_status,text) to service_role;
