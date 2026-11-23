begin;
set local lock_timeout='5s';

alter table public.orders add column live_payment boolean not null default false;
create unique index orders_live_pending_buyer_idx on public.orders(user_id)
 where live_payment and payment_status='pending';

-- Freeze writes across the backfill and FK change. If either table is busy, retry the migration.
lock table public.orders,public.buyer_addresses in access exclusive mode nowait;

create table private.order_delivery_addresses (
  order_id uuid primary key references public.orders(id) on delete cascade,
  full_name text not null,
  address_line text not null,
  postal_code text not null
);
alter table private.order_delivery_addresses enable row level security;
revoke all on private.order_delivery_addresses from public,anon,authenticated,service_role;

create function private.snapshot_order_delivery_address()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into private.order_delivery_addresses(order_id,full_name,address_line,postal_code)
  select new.id,a.full_name,a.address_line,a.postal_code
  from public.buyer_addresses a
  where a.id=new.address_id and a.user_id=new.user_id
  for share of a;
  if not found then raise exception using errcode='P0001',message='ADDRESS_INVALID'; end if;
  return null;
end $$;
revoke all on function private.snapshot_order_delivery_address() from public,anon,authenticated,service_role;

-- Only copy an owned address that has never been edited. Transaction-start timestamps
-- cannot prove whether an edit preceded checkout. Unverified addresses remain unavailable.
insert into private.order_delivery_addresses(order_id,full_name,address_line,postal_code)
select o.id,a.full_name,a.address_line,a.postal_code
from public.orders o
join public.buyer_addresses a on a.id=o.address_id and a.user_id=o.user_id
where a.version=1 and a.created_at=a.updated_at and a.created_at<=o.created_at;

create trigger snapshot_order_delivery_address
after insert on public.orders
for each row execute function private.snapshot_order_delivery_address();

alter table public.orders drop constraint orders_address_id_fkey;
comment on column public.orders.address_id is
  'Address book ID selected at checkout. Delivery details are stored in private.order_delivery_addresses.';

create or replace function public.read_admin_orders(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare result jsonb;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into result from (
  select o.id,'CVM-'||o.order_number as number,u.email,coalesce(p.display_name,'') as customer_name,
   a.full_name,a.address_line,a.postal_code,o.payment_status,o.fulfilment_status,o.tracking_number,
   o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.created_at,o.paid_at,o.version,o.live_payment,
   coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.sku) from public.order_items i where i.order_id=o.id),'[]'::jsonb) items
  from public.orders o join auth.users u on u.id=o.user_id left join public.buyer_profiles p on p.user_id=o.user_id
  left join private.order_delivery_addresses a on a.order_id=o.id
 ) x;
 return result;
end $$;

-- Reuse the existing server-priced reservation, and classify it in the same transaction.
create function public.create_live_order(p_user uuid,p_address uuid,p_coupon text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare created jsonb; previous_order record; order_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('live-checkout:'||p_user,0));
 select o.id,o.stripe_checkout_session_id,o.created_at into previous_order from public.orders o
 where o.user_id=p_user and o.live_payment and o.payment_status='pending' for update;
 if found then
  if previous_order.stripe_checkout_session_id is not null or previous_order.created_at>now()-interval '5 minutes' then
   raise exception using errcode='PT409',message='CHECKOUT_PENDING';
  end if;
  perform public.release_test_order(previous_order.id);
 end if;
 created:=public.create_test_order(p_user,p_address,p_coupon);
 order_id:=(created->>'id')::uuid;
 update public.orders set live_payment=true,expires_at=now()+interval '1 hour' where id=order_id;
 return public.read_order_json(order_id,p_user);
end $$;

create function public.prepare_order_operation(
 p_actor uuid,p_order uuid,p_version integer,p_action text,p_restock boolean,p_live boolean
) returns jsonb language plpgsql security definer set search_path='' as $$
declare order_live boolean;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select live_payment into order_live from public.orders where id=p_order for update;
 if not found or order_live is distinct from p_live then
  raise exception using errcode='22023',message='PAYMENT_MODE_MISMATCH';
 end if;
 return public.prepare_test_order_operation(p_actor,p_order,p_version,p_action,p_restock);
end $$;

-- Called only after the Worker checks Stripe's signed or authenticated expired session.
create function public.cancel_live_checkout(p_user uuid,p_order uuid,p_session text)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_status public.order_payment_status;
begin
 select payment_status into current_status from public.orders
 where id=p_order and user_id=p_user and live_payment and stripe_checkout_session_id=p_session for update;
 if not found then return false; end if;
 if current_status='failed' then return true; end if;
 if not public.release_test_order(p_order) then return false; end if;
 perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 return true;
end $$;

revoke all on function public.create_live_order(uuid,uuid,text),
 public.prepare_order_operation(uuid,uuid,integer,text,boolean,boolean),
 public.cancel_live_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.create_live_order(uuid,uuid,text),
 public.prepare_order_operation(uuid,uuid,integer,text,boolean,boolean),
 public.cancel_live_checkout(uuid,uuid,text) to service_role;

create or replace function public.enqueue_order_email(p_order uuid,p_kind public.email_job_kind,p_source_key text)
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare o public.orders; address text; job uuid; key text;
begin
 select * into o from public.orders where id=p_order;
 if not found or not (o.payment_status in ('paid','refunded') or
   (p_kind='cancellation' and o.payment_status='failed' and o.fulfilment_status='Cancelled')) then return null; end if;
 select lower(u.email) into address from auth.users u where u.id=o.user_id and u.email is not null and (not o.live_payment or u.email_confirmed_at is not null);
 if address is null then return null; end if;
 key:=p_kind::text||'/'||p_source_key;
 insert into public.email_jobs(order_id,kind,recipient,recipient_hash,payload,is_test,idempotency_key)
 values(o.id,p_kind,address,public.email_recipient_hash(address),
   jsonb_build_object('orderNumber','CVM-'||o.order_number,'total',o.total_cents,'currency',o.currency,
     'tracking',case when p_kind='shipment' then o.tracking_number else '' end),not o.live_payment,key)
 on conflict(idempotency_key) do nothing returning id into job;
 return coalesce(job,(select id from public.email_jobs where idempotency_key=key));
end $$;

create or replace function public.apply_test_payment_event(p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; outcome text; job uuid; kind public.email_job_kind;
begin
 perform pg_advisory_xact_lock(hashtextextended('stripe:'||p_event,0));
 if exists(select 1 from public.stripe_webhook_events where event_id=p_event) then return jsonb_build_object('duplicate',true); end if;
 select * into o from public.orders where id=p_order for update;
 if not found and p_livemode is true then raise exception using errcode='22023',message='ORDER_NOT_FOUND'; end if;
 if found and o.live_payment is distinct from p_livemode then
  raise exception using errcode='22023',message='PAYMENT_MODE_MISMATCH';
 end if;
 if not found then outcome:='order_not_found';
 elsif p_type in ('checkout.session.completed','checkout.session.async_payment_succeeded') then
  if o.payment_status<>'pending' or o.stripe_checkout_session_id is distinct from p_session or o.total_cents is distinct from p_amount or p_currency is distinct from 'sgd' then outcome:='payment_mismatch';
  else
   if p_livemode and coalesce(p_intent,'') !~ '^pi_[A-Za-z0-9_]+$' then
    raise exception using errcode='22023',message='PAYMENT_REFERENCE_INVALID';
   end if;
   perform 1 from public.products p join public.order_items i on i.sku=p.sku where i.order_id=o.id order by p.sku for update of p;
   if p_livemode and exists(
    select 1 from public.order_items i join public.products p on p.sku=i.sku
    where i.order_id=o.id and (p.stock<i.quantity or p.reserved_quantity<i.quantity)
   ) then raise exception using errcode='23514',message='RESERVATION_INVALID'; end if;
   insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key)
    select p.id,p.stock,-i.quantity,p.stock-i.quantity,case when p_livemode then 'stripe_payment' else 'stripe_test_payment' end,'stripe:'||p_event||':'||p.id from public.order_items i join public.products p on p.sku=i.sku where i.order_id=o.id;
   update public.products p set stock=p.stock-i.quantity,reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
    from public.order_items i where i.order_id=o.id and i.sku=p.sku and p.stock>=i.quantity;
   update public.orders set payment_status='paid',stripe_payment_intent_id=nullif(p_intent,''),paid_at=now(),updated_at=now(),version=version+1 where id=o.id;
   if p_livemode then
    delete from public.buyer_cart_items c using public.order_items i
    where c.user_id=o.user_id and i.order_id=o.id and c.sku=i.sku and c.quantity=i.quantity;
   else
    delete from public.buyer_cart_items where user_id=o.user_id;
   end if;
   outcome:='paid';
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
 if p_livemode and outcome='payment_mismatch' and
    (o.stripe_checkout_session_id is distinct from p_session or o.total_cents is distinct from p_amount
     or p_currency is distinct from o.currency or
     (p_type in ('checkout.session.completed','checkout.session.async_payment_succeeded')
      and o.stripe_payment_intent_id is distinct from p_intent)) then
  raise exception using errcode='22023',message='PAYMENT_MISMATCH';
 end if;
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

create or replace function public.finish_test_order_operation(p_actor uuid,p_order uuid,p_action text,p_provider text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare o public.orders; op public.order_operations; item record; before_stock integer;
begin
 if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 select * into op from public.order_operations where order_id=p_order and action=p_action for update;
 if not found or nullif(p_provider,'') is null then raise exception using errcode='22023'; end if;
 if op.status='completed' then return true; end if;
 if op.action='cancel' and p_provider='checkout_completed' then
  update public.order_operations set status='aborted',completed_at=now() where order_id=p_order and action=p_action;
  return false;
 end if;
 if op.action='cancel' then
  if o.payment_status='pending' then
   perform public.release_test_order(p_order);
   perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
  elsif not (o.payment_status='failed' and o.fulfilment_status='Cancelled'
      and o.stripe_checkout_session_id=p_provider) then
   raise exception using errcode='40001';
  end if;
 else
  if o.payment_status<>'paid' or p_provider !~ '^re_' then raise exception using errcode='40001'; end if;
  if op.restock then
   for item in select * from public.order_items where order_id=p_order order by sku loop
    select stock into before_stock from public.products where sku=item.sku for update;
    update public.products set stock=stock+item.quantity,version=version+1 where sku=item.sku;
    insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key,actor_id)
    values(item.sku,before_stock,item.quantity,before_stock+item.quantity,case when o.live_payment then 'stripe_refund' else 'test_refund' end,'refund:'||p_order||':'||item.sku,p_actor);
   end loop;
  end if;
  update public.orders set payment_status='refunded',fulfilment_status='Cancelled',version=version+1,updated_at=now() where id=p_order;
  perform public.queue_test_order_notice(p_order,'test_refund','refund/'||p_order);
  perform public.queue_test_order_notice(p_order,'cancellation','refund-cancellation/'||p_order);
 end if;
 update public.order_operations set status='completed',provider_id=p_provider,completed_at=now() where order_id=p_order and action=p_action;
 return true;
end $$;

commit;
