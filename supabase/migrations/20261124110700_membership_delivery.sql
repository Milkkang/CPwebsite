begin;

alter table public.orders add column delivery_allowance_cents integer not null default 0
 check (delivery_allowance_cents between 0 and 390);

create table private.membership_delivery_claims (
 order_id uuid primary key references public.orders(id),
 purchase_id uuid not null references public.paid_membership_purchases(id),
 member_month integer not null check (member_month between 0 and 11),
 month_start timestamptz not null,
 month_end timestamptz not null check (month_end>month_start),
 amount integer not null check (amount between 1 and 390),
 state text not null default 'reserved' check (state in ('reserved','used','released')),
 updated_at timestamptz not null default now()
);
alter table private.membership_delivery_claims enable row level security;
revoke all on private.membership_delivery_claims from public,anon,authenticated,service_role;
create unique index membership_delivery_one_per_month
 on private.membership_delivery_claims(purchase_id,member_month) where state in ('reserved','used');
create index membership_delivery_reservation_age
 on private.membership_delivery_claims(updated_at,order_id) where state='reserved';

-- Each month uses the original term's day, including terms that begin on the 31st.
create function private.membership_delivery_month(p_user uuid,p_live boolean,p_at timestamptz)
returns table(purchase_id uuid,member_month integer,starts_at timestamptz,expires_at timestamptz)
language sql stable set search_path='' as $$
 select p.purchase_id,m.n,b.starts_at,least(b.expires_at,p.expires_at)
 from public.active_paid_membership_period(p_user,p_live,p_at) p
 cross join lateral pg_catalog.generate_series(0,11) m(n)
 cross join lateral (select
  ((p.starts_at at time zone 'Asia/Singapore')+pg_catalog.make_interval(months=>m.n)) at time zone 'Asia/Singapore',
  ((p.starts_at at time zone 'Asia/Singapore')+pg_catalog.make_interval(months=>m.n+1)) at time zone 'Asia/Singapore'
 ) b(starts_at,expires_at)
 where b.starts_at<=p_at and p_at<least(b.expires_at,p.expires_at)
$$;

create function public.read_membership_delivery(p_user uuid,p_live boolean)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('available',c.order_id is null,'status',coalesce(c.state,'available'),
  'amount',390,'minimum',3000,'expiresAt',m.expires_at)
 from private.membership_delivery_month(p_user,p_live,statement_timestamp()) m
 left join private.membership_delivery_claims c on c.purchase_id=m.purchase_id and c.member_month=m.member_month
  and c.state in ('reserved','used')
$$;

create function public.quote_delivery_checkout(
 p_user uuid,p_launch timestamptz,p_live boolean,p_member_coupon text,p_coupon text,p_points integer,p_use boolean
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare q jsonb; m record; amount integer; shipping integer; total integer;
begin
 q:=public.quote_points_checkout(p_user,p_launch,p_live,p_member_coupon,p_coupon,p_points);
 if p_use is distinct from true then return q; end if;
 if p_launch is null or statement_timestamp()<p_launch or not exists(
  select 1 from auth.users where id=p_user and email_confirmed_at is not null and deleted_at is null
    and (banned_until is null or banned_until<=statement_timestamp())
 ) then raise exception using errcode='PT409',message='DELIVERY_ALLOWANCE_UNAVAILABLE'; end if;
 select * into m from private.membership_delivery_month(p_user,p_live,statement_timestamp());
 if not found or exists(select 1 from private.membership_delivery_claims c where c.purchase_id=m.purchase_id
  and c.member_month=m.member_month and c.state in ('reserved','used'))
 then raise exception using errcode='PT409',message='DELIVERY_ALLOWANCE_UNAVAILABLE'; end if;
 shipping:=(q->>'shipping')::integer;
 total:=(q->>'total')::integer;
 if shipping=0 then raise exception using errcode='PT409',message='DELIVERY_ALREADY_FREE'; end if;
 if (q->>'subtotal')::integer<3000 then raise exception using errcode='PT409',message='DELIVERY_ALLOWANCE_MINIMUM'; end if;
 amount:=least(390,shipping);
 if total-amount<50 then raise exception using errcode='PT409',message='DELIVERY_ALLOWANCE_MINIMUM_PAYMENT'; end if;
 return q||jsonb_build_object('shipping',shipping-amount,'total',total-amount,'deliveryAllowance',
  jsonb_build_object('amount',390,'discount',amount,'month',m.purchase_id||'/'||m.member_month,'expiresAt',m.expires_at));
end $$;

create function public.create_delivery_order(
 p_user uuid,p_address uuid,p_launch timestamptz,p_live boolean,p_member_coupon text,p_coupon text,
 p_points integer,p_use boolean,p_expected_total integer,p_month text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare q jsonb; created jsonb; m record; checkout_id uuid; amount integer;
begin
 if p_use is distinct from true then raise exception using errcode='22023',message='DELIVERY_ALLOWANCE_UNAVAILABLE'; end if;
 if not p_live then
  perform pg_advisory_xact_lock(hashtextextended('welcome-checkout:'||p_user,0));
  perform private.release_unattached_welcome_order(p_user,false);
  if public.read_pending_welcome_checkout(p_user) is not null then
   raise exception using errcode='PT409',message='CHECKOUT_PENDING';
  end if;
 end if;
 q:=public.quote_delivery_checkout(p_user,p_launch,p_live,p_member_coupon,p_coupon,p_points,true);
 if p_expected_total is distinct from (q->>'total')::integer or
    p_month is distinct from q#>>'{deliveryAllowance,month}' then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 amount:=(q#>>'{deliveryAllowance,discount}')::integer;
 created:=public.create_points_order(p_user,p_address,p_launch,p_live,p_member_coupon,p_coupon,p_points,p_expected_total+amount);
 checkout_id:=(created->>'id')::uuid;
 if (created->>'subtotal_cents')::integer is distinct from (q->>'subtotal')::integer or
    (created->>'shipping_cents')::integer is distinct from (q->>'shipping')::integer+amount then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 select * into m from private.membership_delivery_month(p_user,p_live,clock_timestamp());
 if not found or p_month is distinct from m.purchase_id||'/'||m.member_month then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 insert into private.membership_delivery_claims(order_id,purchase_id,member_month,month_start,month_end,amount)
 values(checkout_id,m.purchase_id,m.member_month,m.starts_at,m.expires_at,amount) on conflict do nothing;
 if not found then raise exception using errcode='PT409',message='DELIVERY_ALLOWANCE_UNAVAILABLE'; end if;
 update public.orders set shipping_cents=shipping_cents-amount,total_cents=p_expected_total,
  delivery_allowance_cents=amount where id=checkout_id;
 return created||jsonb_build_object('shipping_cents',(q->>'shipping')::integer,'total_cents',p_expected_total,
  'delivery_allowance_cents',amount);
end $$;

create function private.settle_membership_delivery_claim()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.payment_status='pending' then
  update private.membership_delivery_claims set state=case when new.payment_status='paid' then 'used' else 'released' end,
   updated_at=now() where order_id=new.id and state='reserved';
 elsif old.payment_status='paid' and new.payment_status='refunded' and old.fulfilment_status='Processing'
       and new.refunded_cents=new.total_cents then
  update private.membership_delivery_claims set state='released',updated_at=now()
   where order_id=new.id and state='used' and month_end>clock_timestamp();
 end if;
 return null;
end $$;
create trigger settle_membership_delivery_claim after update of payment_status on public.orders
 for each row when (old.payment_status is distinct from new.payment_status and new.delivery_allowance_cents>0)
 execute function private.settle_membership_delivery_claim();

create or replace function private.release_unattached_welcome_order(p_user uuid,p_live boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare abandoned_id uuid;
begin
 for abandoned_id in select o.id from public.orders o where o.user_id=p_user and o.live_payment=p_live
  and o.payment_status='pending' and o.stripe_checkout_session_id is null and o.created_at<=now()-interval '5 minutes'
  and (o.delivery_allowance_cents>0 or exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id and w.state='reserved')
   or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id and r.state='reserved'))
  order by o.id for update of o
 loop perform public.release_test_order(abandoned_id); end loop;
end $$;

create or replace function public.release_stale_member_campaign_order()
returns boolean language plpgsql security definer set search_path='' as $$
declare abandoned_id uuid;
begin
 select o.id into abandoned_id from public.orders o
 join (
  select r.order_id,r.reserved_at as created_at from private.member_campaign_redemptions r
   where r.state='reserved' and r.reserved_at<=now()-interval '5 minutes'
  union all
  select c.order_id,c.updated_at from private.membership_delivery_claims c
   where c.state='reserved' and c.updated_at<=now()-interval '5 minutes'
 ) reservations on reservations.order_id=o.id
 where o.payment_status='pending' and o.stripe_checkout_session_id is null
 order by reservations.created_at,o.id limit 1 for update of o skip locked;
 if not found then return false; end if;
 return public.release_test_order(abandoned_id);
end $$;

create or replace function public.read_pending_welcome_checkout(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',o.id,'stripe_checkout_session_id',o.stripe_checkout_session_id)
 from public.orders o where o.user_id=p_user and not o.live_payment and o.payment_status='pending'
 and (o.delivery_allowance_cents>0 or exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id and w.state='reserved')
  or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id and r.state='reserved'))
 order by o.created_at,o.id limit 1
$$;

create or replace function public.cancel_welcome_checkout(p_user uuid,p_order uuid,p_session text)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_status public.order_payment_status;
begin
 select o.payment_status into current_status from public.orders o
 where o.id=p_order and o.user_id=p_user and not o.live_payment and o.stripe_checkout_session_id=p_session
 and (o.delivery_allowance_cents>0 or exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id)
  or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id)) for update of o;
 if not found then return false; end if;
 if current_status='failed' then return true; end if;
 if not public.release_test_order(p_order) then return false; end if;
 perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 return true;
end $$;

create or replace function private.require_open_member_checkout()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not new.live_payment and public.read_pending_welcome_checkout(new.user_id) is not null then
  raise exception using errcode='PT409',message='CHECKOUT_PENDING';
 end if;
 return new;
end $$;

revoke all on function private.membership_delivery_month(uuid,boolean,timestamptz),
 private.settle_membership_delivery_claim() from public,anon,authenticated,service_role;
revoke all on function public.read_membership_delivery(uuid,boolean),
 public.quote_delivery_checkout(uuid,timestamptz,boolean,text,text,integer,boolean),
 public.create_delivery_order(uuid,uuid,timestamptz,boolean,text,text,integer,boolean,integer,text)
 from public,anon,authenticated;
grant execute on function public.read_membership_delivery(uuid,boolean),
 public.quote_delivery_checkout(uuid,timestamptz,boolean,text,text,integer,boolean),
 public.create_delivery_order(uuid,uuid,timestamptz,boolean,text,text,integer,boolean,integer,text)
 to service_role;

commit;
