begin;
set local lock_timeout='5s';

create index orders_formally_paid_buyer_idx on public.orders(user_id)
 where live_payment and (paid_at is not null or payment_status in ('paid','refunded'));

create table private.welcome_coupon_reservations (
 order_id uuid primary key,
 user_id uuid not null,
 live_payment boolean not null,
 state text not null default 'reserved' check (state in ('reserved','used','released')),
 reserved_at timestamptz not null default now(),
 resolved_at timestamptz,
 foreign key (order_id,user_id) references public.orders(id,user_id) on delete cascade,
 check ((state='reserved')=(resolved_at is null))
);
alter table private.welcome_coupon_reservations enable row level security;
revoke all on private.welcome_coupon_reservations from public,anon,authenticated,service_role;
create unique index welcome_coupon_one_use_idx on private.welcome_coupon_reservations(user_id,live_payment)
 where state in ('reserved','used');

create function private.membership_status(p_user uuid,p_launch timestamptz,p_live boolean)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare verified_at timestamptz; expires_at timestamptz; coupon_state text;
begin
 select email_confirmed_at into verified_at from auth.users
 where id=p_user and deleted_at is null and (banned_until is null or banned_until<=now());
 if verified_at is null or p_launch is null or now()<p_launch then
  return jsonb_build_object('enabled',false,'member',verified_at is not null,'welcome',null);
 end if;
 expires_at:=greatest(verified_at,p_launch)+interval '720 hours';
 select state into coupon_state from private.welcome_coupon_reservations
 where user_id=p_user and live_payment=p_live and state in ('reserved','used');
 if coupon_state is distinct from 'used' then
  if exists(select 1 from public.orders where user_id=p_user and live_payment
    and (paid_at is not null or payment_status in ('paid','refunded'))) then
   coupon_state:='ineligible';
  elsif coupon_state is null then
   coupon_state:=case when now()>=expires_at then 'expired' else 'available' end;
  end if;
 end if;
 return jsonb_build_object('enabled',true,'member',true,'welcome',jsonb_build_object(
  'status',coupon_state,'discount',300,'minimum',5000,'expiresAt',expires_at));
end $$;

-- A request interrupted before attachment never handed a Stripe URL to the buyer.
create function private.release_unattached_welcome_order(p_user uuid,p_live boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare abandoned_id uuid;
begin
 select o.id into abandoned_id from public.orders o
 join private.welcome_coupon_reservations w on w.order_id=o.id
 where w.user_id=p_user and w.live_payment=p_live and w.state='reserved' and o.payment_status='pending'
  and o.stripe_checkout_session_id is null and o.created_at<=now()-interval '5 minutes'
 for update of o;
 if found then perform public.release_test_order(abandoned_id); end if;
end $$;

create function public.read_membership(p_user uuid,p_launch timestamptz,p_live boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.release_unattached_welcome_order(p_user,p_live);
 return private.membership_status(p_user,p_launch,p_live);
end $$;

create function private.welcome_discount(p_user uuid,p_launch timestamptz,p_live boolean,p_subtotal integer)
returns integer language plpgsql stable security invoker set search_path='' as $$
declare coupon jsonb;
begin
 coupon:=private.membership_status(p_user,p_launch,p_live)->'welcome';
 if coupon->>'status'='reserved' then
  raise exception using errcode='PT409',message='CHECKOUT_PENDING';
 end if;
 if coupon->>'status' is distinct from 'available' then
  raise exception using errcode='PT409',message='WELCOME_UNAVAILABLE';
 end if;
 if p_subtotal<(coupon->>'minimum')::integer then
  raise exception using errcode='PT409',message='WELCOME_MINIMUM';
 end if;
 return (coupon->>'discount')::integer;
end $$;

create function public.quote_welcome_checkout(p_user uuid,p_launch timestamptz,p_live boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare subtotal integer; item_count integer; valid_count integer; shipping integer; discount integer;
begin
 select count(*),count(*) filter (where p.status='Published' and c.quantity between p.min_quantity and p.available_quantity),
  coalesce(sum(p.price_cents*c.quantity),0)
 into item_count,valid_count,subtotal
 from public.buyer_cart_items c join public.products p on p.sku=c.sku where c.user_id=p_user;
 if item_count=0 or item_count<>valid_count then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 select case when subtotal>=d.free_threshold_cents then 0 else d.shipping_cents end into shipping
 from public.delivery_rules d where d.country_code='SG' and d.active order by d.id limit 1;
 if shipping is null then raise exception using errcode='PT409',message='DELIVERY_UNAVAILABLE'; end if;
 discount:=private.welcome_discount(p_user,p_launch,p_live,subtotal);
 return jsonb_build_object('subtotal',subtotal,'shipping',shipping,'discount',discount,'total',subtotal+shipping-discount);
end $$;

-- The same server-priced order and stock reservation used by legacy checkout
-- provides the authoritative subtotal. A stale quote rolls back the entire order.
create function public.create_welcome_order(
 p_user uuid,p_address uuid,p_launch timestamptz,p_live boolean,p_expected_total integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare created jsonb; checkout_id uuid; discount integer; total integer; item_subtotal integer; valid_items boolean;
begin
 if p_live then
  created:=public.create_live_order(p_user,p_address,null);
 else
  perform pg_advisory_xact_lock(hashtextextended('welcome-checkout:'||p_user,0));
  perform private.release_unattached_welcome_order(p_user,false);
  created:=public.create_test_order(p_user,p_address,null);
 end if;
 checkout_id:=(created->>'id')::uuid;
 select sum(i.unit_cents*i.quantity),bool_and(p.status='Published' and i.quantity>=p.min_quantity and i.unit_cents=p.price_cents)
 into item_subtotal,valid_items
 from public.order_items i join public.products p on p.sku=i.sku where i.order_id=checkout_id;
 if valid_items is distinct from true or item_subtotal is distinct from (created->>'subtotal_cents')::integer then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 discount:=private.welcome_discount(p_user,p_launch,p_live,item_subtotal);
 total:=(created->>'total_cents')::integer-discount;
 if total is distinct from p_expected_total then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 update public.orders set discount_cents=discount,total_cents=total where id=checkout_id;
 insert into private.welcome_coupon_reservations(order_id,user_id,live_payment) values(checkout_id,p_user,p_live);
 return public.read_order_json(checkout_id,p_user);
end $$;

-- The order update and coupon transition commit together, including Stripe
-- expiry/async failure and both customer and administrator cancellation.
create function private.resolve_welcome_coupon_reservation()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.welcome_coupon_reservations
 set state=case when new.payment_status='paid' then 'used' else 'released' end,resolved_at=now()
 where order_id=new.id and state='reserved';
 return null;
end $$;
create trigger resolve_welcome_coupon_reservation after update of payment_status on public.orders
 for each row when (old.payment_status='pending' and new.payment_status in ('paid','failed','expired'))
 execute function private.resolve_welcome_coupon_reservation();

create function public.read_pending_welcome_checkout(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',o.id,'stripe_checkout_session_id',o.stripe_checkout_session_id)
 from private.welcome_coupon_reservations w join public.orders o on o.id=w.order_id
 where w.user_id=p_user and not w.live_payment and w.state='reserved' and o.payment_status='pending'
$$;

-- Sandbox cancellation is restricted to owned welcome orders and uses the same
-- provider-expiry verification as formal customer cancellation.
create function public.cancel_welcome_checkout(p_user uuid,p_order uuid,p_session text)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_status public.order_payment_status;
begin
 select o.payment_status into current_status from public.orders o
 join private.welcome_coupon_reservations w on w.order_id=o.id
 where o.id=p_order and o.user_id=p_user and not o.live_payment and o.stripe_checkout_session_id=p_session
 for update of o;
 if not found then return false; end if;
 if current_status='failed' then return true; end if;
 if not public.release_test_order(p_order) then return false; end if;
 perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 return true;
end $$;

revoke all on function private.welcome_discount(uuid,timestamptz,boolean,integer),
 private.membership_status(uuid,timestamptz,boolean),
 private.release_unattached_welcome_order(uuid,boolean),
 private.resolve_welcome_coupon_reservation() from public,anon,authenticated,service_role;
revoke all on function public.read_membership(uuid,timestamptz,boolean),
 public.quote_welcome_checkout(uuid,timestamptz,boolean),
 public.create_welcome_order(uuid,uuid,timestamptz,boolean,integer),
 public.read_pending_welcome_checkout(uuid),
 public.cancel_welcome_checkout(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.read_membership(uuid,timestamptz,boolean),
 public.quote_welcome_checkout(uuid,timestamptz,boolean),
 public.create_welcome_order(uuid,uuid,timestamptz,boolean,integer),
 public.read_pending_welcome_checkout(uuid),
 public.cancel_welcome_checkout(uuid,uuid,text) to service_role;

commit;
