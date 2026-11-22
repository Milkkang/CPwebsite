begin;

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

-- Only copy an owned address whose current values were recorded when the order was placed.
-- A modified address with an equal timestamp may have changed later in the same transaction.
insert into private.order_delivery_addresses(order_id,full_name,address_line,postal_code)
select o.id,a.full_name,a.address_line,a.postal_code
from public.orders o
join public.buyer_addresses a on a.id=o.address_id and a.user_id=o.user_id
where a.created_at<=o.created_at
  and (a.updated_at<o.created_at or (a.updated_at=o.created_at and a.version=1));

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
   o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.created_at,o.paid_at,o.version,
   coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.sku) from public.order_items i where i.order_id=o.id),'[]'::jsonb) items
  from public.orders o join auth.users u on u.id=o.user_id left join public.buyer_profiles p on p.user_id=o.user_id
  left join private.order_delivery_addresses a on a.order_id=o.id
 ) x;
 return result;
end $$;

commit;
