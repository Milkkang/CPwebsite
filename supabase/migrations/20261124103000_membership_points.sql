begin;
set local lock_timeout='5s';

alter table public.orders
 add column member_points_eligible boolean not null default false,
 add column member_points_redeemed integer not null default 0,
 add constraint order_points_requires_formal_order check (not member_points_eligible or live_payment),
 add constraint order_redeemed_points_valid check (
  member_points_redeemed between 0 and discount_cents and
  (member_points_redeemed=0 or (member_points_eligible and member_points_redeemed>=100))
 );

create table private.membership_point_accounts (
 user_id uuid primary key references auth.users(id),
 debt bigint not null default 0 check (debt>=0)
);
create table private.membership_point_lots (
 id bigint generated always as identity primary key,
 user_id uuid not null references auth.users(id),
 issued integer not null check (issued>0),
 remaining integer not null check (remaining between 0 and issued),
 expires_at timestamptz not null
);
create index membership_point_lots_buyer_idx on private.membership_point_lots(user_id,expires_at,id) where remaining>0;

create table private.membership_point_ledger (
 id bigint generated always as identity primary key,
 source text not null unique,
 user_id uuid not null references auth.users(id),
 order_id uuid references public.orders(id),
 kind text not null check (kind in ('reserved','redeemed','released','pending','credited','adjusted',
  'restored','clawed_back','debt_repaid')),
 points integer not null,
 actor_id uuid references auth.users(id),
 reason text,
 expires_at timestamptz,
 created_at timestamptz not null default now(),
 check ((kind='adjusted')=(actor_id is not null and reason is not null))
);
create index membership_point_ledger_buyer_idx on private.membership_point_ledger(user_id,id desc);

create table private.membership_point_holds (
 order_id uuid not null references public.orders(id),
 lot_id bigint not null references private.membership_point_lots(id),
 point_offset integer not null check (point_offset>=0),
 points integer not null check (points>0),
 primary key(order_id,point_offset),
 unique(lot_id,order_id)
);

create table private.membership_point_earnings (
 order_id uuid primary key references public.orders(id),
 user_id uuid not null references auth.users(id),
 original_points integer not null check (original_points>=0),
 remaining_points integer not null check (remaining_points between 0 and original_points),
 multiplier integer not null check (multiplier>0),
 credited_lot_id bigint unique references private.membership_point_lots(id),
 credited_at timestamptz,
 check (credited_lot_id is null or credited_at is not null)
);
create index membership_pending_points_buyer_idx on private.membership_point_earnings(user_id) where credited_at is null;

create table private.membership_order_lines (
 order_id uuid not null,
 sku text not null,
 quantity integer not null check(quantity>0),
 gross_cents integer not null check(gross_cents>=0),
 coupon_cents integer not null check(coupon_cents>=0),
 point_cents integer not null check(point_cents>=0),
 cash_cents integer not null check(cash_cents>=0),
 point_offset integer not null check(point_offset>=0),
 cash_offset integer not null check(cash_offset>=0),
 primary key(order_id,sku),
 foreign key(order_id,sku) references public.order_items(order_id,sku),
 check(gross_cents=coupon_cents+point_cents+cash_cents)
);

create table private.membership_point_refunds (
 operation_id uuid primary key,
 order_id uuid not null references public.orders(id),
 earned integer not null check(earned>=0),
 ranges jsonb not null check (jsonb_typeof(ranges)='array')
);
create index membership_point_refunds_order_idx on private.membership_point_refunds(order_id);

alter table private.membership_point_accounts enable row level security;
alter table private.membership_point_lots enable row level security;
alter table private.membership_point_ledger enable row level security;
alter table private.membership_point_holds enable row level security;
alter table private.membership_point_earnings enable row level security;
alter table private.membership_order_lines enable row level security;
alter table private.membership_point_refunds enable row level security;
revoke all on private.membership_point_accounts,private.membership_point_lots,private.membership_point_ledger,
 private.membership_point_holds,private.membership_point_earnings,private.membership_order_lines,private.membership_point_refunds
 from public,anon,authenticated,service_role;

create function private.member_points_eligible(p_user uuid,p_launch timestamptz,p_live boolean)
returns boolean language sql stable set search_path='' as $$
 select p_live is true and p_launch is not null and p_launch<=now()
 and exists(select 1 from auth.users where id=p_user and email_confirmed_at<=now()
  and deleted_at is null and (banned_until is null or banned_until<=now()))
$$;

create function private.lock_membership_point_account(p_user uuid)
returns void language plpgsql set search_path='' as $$
begin
 insert into private.membership_point_accounts(user_id) values(p_user) on conflict do nothing;
 perform 1 from private.membership_point_accounts where user_id=p_user for no key update;
end $$;

-- A hold consumes spendable balance while the order is pending. Releasing a
-- hold never extends its expiry. Refunds and debt settlement may target a
-- specific lot even after its unused points expire.
create function private.membership_unheld_lots(p_user uuid,p_original_lot bigint default null)
returns table(id bigint,expires_at timestamptz,points integer) language sql stable set search_path='' as $$
 select l.id,l.expires_at,(l.remaining-coalesce((
  select sum(h.points) from private.membership_point_holds h
  join public.orders o on o.id=h.order_id where h.lot_id=l.id and o.payment_status='pending'
 ),0))::integer
 from private.membership_point_lots l
 where l.user_id=p_user and l.remaining>0
  and (l.id=p_original_lot or (p_original_lot is null and l.expires_at>now()))
$$;

create function private.membership_points_summary(p_user uuid,p_audit boolean)
returns jsonb language sql stable set search_path='' as $$
 with balance as (
  select coalesce(sum(points),0) available,
   coalesce(sum(points) filter(where expires_at<=now()+interval '30 days'),0) expiring,
   min(expires_at) filter(where points>0 and expires_at<=now()+interval '30 days') next_expiry
  from private.membership_unheld_lots(p_user)
 ), pending as (
  select coalesce(sum(remaining_points),0) as points from private.membership_point_earnings
  where user_id=p_user and credited_at is null
 ), history as (
  select coalesce(jsonb_agg(jsonb_build_object('kind',l.kind,'points',l.points,'createdAt',l.created_at,
   'expiresAt',l.expires_at,'orderNumber',case when o.order_number is not null then 'CVM-'||o.order_number end)
   ||case when p_audit then jsonb_build_object('actor',l.actor_id,'actorEmail',a.email,'reason',l.reason) else '{}'::jsonb end
   order by l.id desc),'[]'::jsonb) as entries
  from (select * from private.membership_point_ledger where user_id=p_user order by id desc limit 100) l
  left join public.orders o on o.id=l.order_id
  left join auth.users a on p_audit and a.id=l.actor_id
 )
 select jsonb_build_object('available',balance.available,'pending',pending.points,
  'expiring',balance.expiring,'nextExpiryAt',balance.next_expiry,'ledger',history.entries,
  'debt',coalesce((select debt from private.membership_point_accounts where user_id=p_user),0))
 from balance,pending,history
$$;

create function public.read_member_points(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select private.membership_points_summary(p_user,false)
$$;

create function public.read_admin_member_points(p_actor uuid,p_email text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare buyer record;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select id,email,email_confirmed_at is not null as verified into buyer
 from auth.users where lower(email)=lower(trim(p_email)) and deleted_at is null
 order by id limit 1;
 if not found then return null; end if;
 return jsonb_build_object('accountId',buyer.id,'email',buyer.email,'verified',buyer.verified,
  'points',private.membership_points_summary(buyer.id,true));
end $$;

-- Callers hold the buyer account row before allocating points or shrinking lots.
-- The lot order is deterministic when multiple credits have the same expiry.
create function private.take_membership_points(p_user uuid,p_points integer,p_order uuid)
returns integer language plpgsql set search_path='' as $$
declare lot record; taken integer:=0; debit integer;
begin
 for lot in select * from private.membership_unheld_lots(p_user) where points>0 order by expires_at,id
 loop
  debit:=least(p_points-taken,lot.points);
  exit when debit=0;
  if p_order is null then
   update private.membership_point_lots set remaining=remaining-debit where id=lot.id;
  else
   insert into private.membership_point_holds(order_id,lot_id,point_offset,points) values(p_order,lot.id,taken,debit);
  end if;
  taken:=taken+debit;
 end loop;
 return taken;
end $$;

create function public.adjust_member_points(p_actor uuid,p_user uuid,p_points integer,p_reason text,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare prior private.membership_point_ledger; source_key text:='adjust/'||p_request; expiry timestamptz;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 if p_points is null or p_points=0 or p_points not between -1000000 and 1000000 or
    p_reason is null or char_length(trim(p_reason)) not between 1 and 500 or p_request is null or
    not private.member_points_eligible(p_user,now(),true) then
  raise exception using errcode='22023',message='POINTS_ADJUSTMENT_INVALID';
 end if;
 perform private.lock_membership_point_account(p_user);
 select * into prior from private.membership_point_ledger where source=source_key;
 if found then
  if (prior.user_id,prior.actor_id,prior.points,prior.reason) is distinct from (p_user,p_actor,p_points,trim(p_reason)) then
   raise exception using errcode='PT409',message='POINTS_REQUEST_CHANGED';
  end if;
  return private.membership_points_summary(p_user,true);
 end if;
 if p_points>0 then
  expiry:=now()+interval '12 months';
  insert into private.membership_point_lots(user_id,issued,remaining,expires_at) values(p_user,p_points,p_points,expiry);
 elsif private.take_membership_points(p_user,-p_points,null)<>-p_points then
  raise exception using errcode='PT409',message='POINTS_LIMIT';
 end if;
 insert into private.membership_point_ledger(source,user_id,kind,points,actor_id,reason,expires_at)
 values(source_key,p_user,'adjusted',p_points,p_actor,trim(p_reason),expiry);
 return private.membership_points_summary(p_user,true);
end $$;

-- Reuse member-coupon eligibility and reproduce the public checkout pricing for
-- ordinary baskets. The create path rechecks against the stock-reserving RPC.
create function private.quote_points_coupon(p_user uuid,p_launch timestamptz,p_live boolean,p_member_coupon text,p_coupon text)
returns jsonb language plpgsql stable set search_path='' as $$
declare subtotal integer; item_count integer; valid_count integer; shipping integer; discount integer:=0; coupon public.coupons;
begin
 if p_member_coupon is not null then
  if nullif(trim(p_coupon),'') is not null then raise exception using errcode='22023',message='MULTIPLE_COUPONS'; end if;
  if p_member_coupon='welcome' then return public.quote_welcome_checkout(p_user,p_launch,p_live); end if;
  return public.quote_campaign_checkout(p_user,p_member_coupon::uuid,p_launch,p_live);
 end if;
 select count(*),count(*) filter (where p.status='Published' and c.quantity between p.min_quantity and p.available_quantity),
  coalesce(sum(p.price_cents*c.quantity),0)
 into item_count,valid_count,subtotal
 from public.buyer_cart_items c join public.products p on p.sku=c.sku where c.user_id=p_user;
 if item_count=0 or item_count<>valid_count then raise exception using errcode='PT409',message='CART_CHANGED'; end if;
 select case when subtotal>=d.free_threshold_cents then 0 else d.shipping_cents end into shipping
 from public.delivery_rules d where d.country_code='SG' and d.active order by d.id limit 1;
 if shipping is null then raise exception using errcode='PT409',message='DELIVERY_UNAVAILABLE'; end if;
 if nullif(trim(p_coupon),'') is not null then
  select * into coupon from public.coupons where code=upper(trim(p_coupon)) and active;
  if not found or subtotal<coupon.minimum_cents then raise exception using errcode='PT409',message='COUPON_INVALID'; end if;
  if coupon.kind='shipping' then shipping:=0;
  elsif coupon.kind='fixed' then discount:=least(subtotal,coupon.amount);
  else discount:=round(subtotal*coupon.amount/100.0); end if;
 end if;
 discount:=least(discount,subtotal+shipping-50);
 return jsonb_build_object('subtotal',subtotal,'shipping',shipping,'discount',discount,'total',subtotal+shipping-discount);
end $$;

create function private.apply_points_quote(p_user uuid,p_launch timestamptz,p_live boolean,p_points integer,p_coupon_quote jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare
 subtotal integer:=(p_coupon_quote->>'subtotal')::integer;
 shipping integer:=(p_coupon_quote->>'shipping')::integer;
 discount integer:=(p_coupon_quote->>'discount')::integer;
 total integer:=(p_coupon_quote->>'total')::integer;
 allowed integer:=0;
begin
 if p_points is null or p_points<0 or p_points between 1 and 99 then
  raise exception using errcode='22023',message='POINTS_MINIMUM';
 end if;
 if private.member_points_eligible(p_user,p_launch,p_live) then
  select least(coalesce(sum(points),0),greatest(0,(subtotal-discount)/10),greatest(0,total-50))
  into allowed from private.membership_unheld_lots(p_user);
  if allowed<100 then allowed:=0; end if;
 elsif p_points>0 then
  raise exception using errcode='PT409',message='POINTS_UNAVAILABLE';
 end if;
 if p_points>allowed then raise exception using errcode='PT409',message='POINTS_LIMIT'; end if;
 return jsonb_build_object('subtotal',subtotal,'shipping',shipping,'discount',discount+p_points,
  'couponDiscount',discount,'pointsDiscount',p_points,'total',total-p_points,'maxPoints',allowed);
end $$;

create function public.quote_points_checkout(p_user uuid,p_launch timestamptz,p_live boolean,p_member_coupon text,p_coupon text,p_points integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_points>0 and not private.member_points_eligible(p_user,p_launch,p_live) then
  raise exception using errcode='PT409',message='POINTS_UNAVAILABLE';
 end if;
 return private.apply_points_quote(p_user,p_launch,p_live,p_points,
  private.quote_points_coupon(p_user,p_launch,p_live,p_member_coupon,p_coupon));
end $$;

create function public.create_points_order(
 p_user uuid,p_address uuid,p_launch timestamptz,p_live boolean,p_member_coupon text,p_coupon text,
 p_points integer,p_expected_total integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 created jsonb; pricing jsonb; coupon_total integer; checkout_id uuid; coupon_discount integer; subtotal integer;
 eligible boolean:=private.member_points_eligible(p_user,p_launch,p_live);
begin
 if p_points>0 and not eligible then raise exception using errcode='PT409',message='POINTS_UNAVAILABLE'; end if;
 if p_member_coupon is not null then
  if nullif(trim(p_coupon),'') is not null then raise exception using errcode='22023',message='MULTIPLE_COUPONS'; end if;
  if p_expected_total is null or p_expected_total::bigint+p_points>2147483647 then
   raise exception using errcode='PT409',message='CART_CHANGED';
  end if;
  coupon_total:=p_expected_total+p_points;
  if p_member_coupon='welcome' then
   created:=public.create_welcome_order(p_user,p_address,p_launch,p_live,coupon_total);
  else
   created:=public.create_campaign_order(p_user,p_address,p_member_coupon::uuid,p_launch,p_live,coupon_total);
  end if;
 elsif p_live then
  created:=public.create_live_order(p_user,p_address,p_coupon);
 else
  created:=public.create_test_order(p_user,p_address,p_coupon);
 end if;
 checkout_id:=(created->>'id')::uuid;
 subtotal:=(created->>'subtotal_cents')::integer;
 coupon_discount:=(created->>'discount_cents')::integer;
 if p_points>0 then perform private.lock_membership_point_account(p_user); end if;
 pricing:=private.apply_points_quote(p_user,p_launch,p_live,p_points,jsonb_build_object(
  'subtotal',subtotal,'shipping',created->'shipping_cents','discount',coupon_discount,'total',created->'total_cents'));
 if (p_points>0 or p_member_coupon is not null or p_expected_total is not null)
   and (pricing->>'total')::integer is distinct from p_expected_total then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 if not eligible then return created; end if;
 if p_points>0 then
  if private.take_membership_points(p_user,p_points,checkout_id)<>p_points then
   raise exception using errcode='PT409',message='POINTS_LIMIT';
  end if;
  insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
  values('reserve/'||checkout_id,p_user,checkout_id,'reserved',-p_points);
 end if;
 update public.orders set member_points_eligible=true,member_points_redeemed=p_points,
  discount_cents=coupon_discount+p_points,total_cents=(pricing->>'total')::integer where id=checkout_id;

 -- Compute all boundaries in cents. Divide the total reduction among lines
 -- first, then split it into coupon and points so no line becomes negative.
 with gross as (
  select sku,quantity,unit_cents*quantity as cents,
   sum(unit_cents*quantity) over (order by sku collate "C") as through
  from public.order_items where order_id=checkout_id
 ), discounts as (
  select *,round((coupon_discount+p_points)::numeric*through/nullif(subtotal,0))::integer as reduction_through
  from gross
 ), boundaries as (
  select *,coalesce(round(p_points::numeric*reduction_through/nullif(coupon_discount+p_points,0)),0)::integer as points_through
  from discounts
 ), shares as (
  select *,reduction_through-lag(reduction_through,1,0) over (order by sku collate "C") as reduction,
   points_through-lag(points_through,1,0) over (order by sku collate "C") as points
  from boundaries
 )
 insert into private.membership_order_lines(order_id,sku,quantity,gross_cents,coupon_cents,point_cents,cash_cents,point_offset,cash_offset)
 select checkout_id,sku,quantity,cents,reduction-points,points,cents-reduction,points_through-points,
  (through-reduction_through-(cents-reduction))::integer
 from shares;

 return public.read_order_json(checkout_id,p_user)||jsonb_build_object('pricing',(
  select jsonb_agg(to_jsonb(l)-'order_id' order by sku collate "C")
  from private.membership_order_lines l where order_id=checkout_id
 ));
end $$;

-- The return workflow uses the original SKU allocations and payment-time
-- multiplier. An order without member_points_eligible predates the rollout or
-- was simulated and has no points snapshot.
create function private.membership_points_multiplier(p_user uuid)
returns integer language sql stable set search_path='' as $$ select 100 $$;

create function private.release_checkout_stock(p_order uuid)
returns void language plpgsql set search_path='' as $$
begin
 perform 1 from public.products p join public.order_items i on i.sku=p.sku
 where i.order_id=p_order order by p.sku for update of p;
 update public.products p set reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
 from public.order_items i where i.order_id=p_order and i.sku=p.sku;
end $$;

create or replace function public.release_test_order(p_order uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.orders where id=p_order and payment_status='pending' for update) then return false; end if;
 perform private.release_checkout_stock(p_order);
 update public.orders set payment_status='failed',fulfilment_status='Cancelled',updated_at=now(),version=version+1 where id=p_order;
 return true;
end $$;

create or replace function public.create_live_order(p_user uuid,p_address uuid,p_coupon text default null)
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
  perform 1 from public.products p where p.sku in (
   select i.sku from public.order_items i where i.order_id=previous_order.id
   union select c.sku from public.buyer_cart_items c where c.user_id=p_user
  ) order by p.sku for update of p;
  perform private.release_checkout_stock(previous_order.id);
 end if;
 created:=public.create_test_order(p_user,p_address,p_coupon);
 order_id:=(created->>'id')::uuid;
 -- Reserve the replacement inventory before the old order's points trigger
 -- locks the account. The former checkout stays pending until then.
 if previous_order.id is not null then
  update public.orders set payment_status='failed',fulfilment_status='Cancelled',updated_at=now(),version=version+1
  where id=previous_order.id;
 end if;
 update public.orders set live_payment=true,expires_at=now()+interval '1 hour' where id=order_id;
 return public.read_order_json(order_id,p_user);
end $$;

revoke all on function private.release_checkout_stock(uuid) from public,anon,authenticated,service_role;

create function private.resolve_order_membership_points()
returns trigger language plpgsql security definer set search_path='' as $$
declare
 earning private.membership_point_earnings;
 rate integer; earned integer; applied integer; expiry timestamptz; credited_lot bigint;
 released record; current_debt bigint; repaid integer:=0;
begin
 if old.payment_status='pending' and new.payment_status in ('failed','expired') then
  if new.member_points_redeemed=0 then return null; end if;
  perform private.lock_membership_point_account(new.user_id);
  insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
  values('release/'||new.id,new.user_id,new.id,'released',new.member_points_redeemed);
  select debt into current_debt from private.membership_point_accounts where user_id=new.user_id;
  if current_debt>0 then
   -- A refund may have kept these exact holds intact and recorded debt.
   -- Pay it from the points just released while the account is still locked.
   for released in
    select l.id,least(h.points,l.points) as points
    from private.membership_point_holds h
    cross join lateral private.membership_unheld_lots(new.user_id,h.lot_id) l
    left join private.membership_point_earnings e on e.credited_lot_id=l.id and e.remaining_points<e.original_points
    where h.order_id=new.id and l.points>0 and (l.expires_at>now() or e.credited_lot_id is not null)
    order by (e.credited_lot_id is null),l.expires_at,l.id
   loop
    applied:=least(current_debt-repaid,released.points);
    exit when applied=0;
    update private.membership_point_lots set remaining=remaining-applied where id=released.id;
    repaid:=repaid+applied;
   end loop;
   if repaid>0 then
    update private.membership_point_accounts set debt=debt-repaid where user_id=new.user_id;
    insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
    values('release-debt-repayment/'||new.id,new.user_id,new.id,'debt_repaid',-repaid);
   end if;
  end if;
  return null;
 end if;
 perform private.lock_membership_point_account(new.user_id);
 if old.payment_status='pending' and new.payment_status='paid' then
  if new.member_points_redeemed>0 then
   -- Payment consumes the original holds even if a lot expired during checkout.
   update private.membership_point_lots l set remaining=l.remaining-h.points
   from private.membership_point_holds h where h.order_id=new.id and h.lot_id=l.id;
   insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
   values('redeem/'||new.id,new.user_id,new.id,'redeemed',-new.member_points_redeemed);
  end if;
  rate:=private.membership_points_multiplier(new.user_id);
  earned:=((new.subtotal_cents-new.discount_cents)::bigint*rate/10000)::integer;
  insert into private.membership_point_earnings(order_id,user_id,original_points,remaining_points,multiplier)
  values(new.id,new.user_id,earned,earned,rate);
  if earned>0 then
   insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
   values('pending/'||new.id,new.user_id,new.id,'pending',earned);
  end if;
 else
  update private.membership_point_earnings set credited_at=now()
  where order_id=new.id and credited_at is null returning * into earning;
  if not found or earning.remaining_points=0 then return null; end if;
  select least(debt,earning.remaining_points) into applied
  from private.membership_point_accounts where user_id=new.user_id;
  earned:=earning.remaining_points-applied;
  if applied>0 then
   update private.membership_point_accounts set debt=debt-applied where user_id=new.user_id;
   insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
   values('debt-repayment/'||new.id,new.user_id,new.id,'debt_repaid',-applied);
  end if;
  if earned>0 then
   expiry:=now()+interval '12 months';
   insert into private.membership_point_lots(user_id,issued,remaining,expires_at)
   values(new.user_id,earned,earned,expiry) returning id into credited_lot;
   update private.membership_point_earnings set credited_lot_id=credited_lot where order_id=new.id;
   insert into private.membership_point_ledger(source,user_id,order_id,kind,points,expires_at)
   values('credit/'||new.id,new.user_id,new.id,'credited',earned,expiry);
  end if;
 end if;
 return null;
end $$;
create trigger resolve_order_membership_points after update of payment_status,fulfilment_status on public.orders
 for each row when (new.member_points_eligible and new.live_payment and (
  (old.payment_status='pending' and new.payment_status in ('paid','failed','expired')) or
  (new.payment_status='paid' and old.fulfilment_status='Shipped' and new.fulfilment_status='Delivered')
 ))
 execute function private.resolve_order_membership_points();

-- Called in the provider-verified refund transaction after the order and any
-- stock updates are locked. Offset ranges refer to the original redeemed
-- points stream, so repeated or partial returns cannot extend any expiry.
create function private.apply_membership_points_refund(p_order uuid,p_operation uuid,p_earned integer,p_ranges jsonb)
returns void language plpgsql set search_path='' as $$
declare
 buying_order public.orders; earning private.membership_point_earnings; prior private.membership_point_refunds;
 restored record; debited integer:=0;
begin
 select * into strict buying_order from public.orders where id=p_order for update;
 if not buying_order.member_points_eligible then return; end if;
 if p_operation is null or p_earned is null or p_earned<0 or jsonb_typeof(p_ranges) is distinct from 'array' then
  raise exception using errcode='22023',message='POINTS_REFUND_INVALID';
 end if;
 select * into prior from private.membership_point_refunds where operation_id=p_operation;
 if found then
  if (prior.order_id,prior.earned,prior.ranges) is distinct from (p_order,p_earned,p_ranges) then
   raise exception using errcode='PT409',message='POINTS_REQUEST_CHANGED';
  end if;
  return;
 end if;
 if buying_order.payment_status not in ('paid','refunded') then
  raise exception using errcode='22023',message='POINTS_REFUND_INVALID';
 end if;
 perform private.lock_membership_point_account(buying_order.user_id);
 select * into strict earning from private.membership_point_earnings where order_id=p_order;
 if p_earned>earning.remaining_points or exists (
  select 1 from (
   select r.*,lag(r."offset"::bigint+r.points) over (order by r."offset") previous_end
   from jsonb_to_recordset(p_ranges) as r("offset" integer,points integer)
  ) entries where "offset" is null or points is null or "offset"<0 or points<=0 or
   "offset"::bigint+points>buying_order.member_points_redeemed or "offset"<previous_end
 ) or exists (
  select 1 from private.membership_point_refunds f
  cross join lateral jsonb_to_recordset(f.ranges) as previous("offset" integer,points integer)
  join jsonb_to_recordset(p_ranges) as next("offset" integer,points integer)
   on next."offset"<previous."offset"+previous.points and previous."offset"<next."offset"+next.points
  where f.order_id=p_order
 ) then raise exception using errcode='22023',message='POINTS_REFUND_INVALID'; end if;

 insert into private.membership_point_refunds(operation_id,order_id,earned,ranges) values(p_operation,p_order,p_earned,p_ranges);
 for restored in
  select l.id,l.expires_at,sum(least(h.point_offset+h.points,r."offset"+r.points)-greatest(h.point_offset,r."offset"))::integer as points
  from private.membership_point_holds h join private.membership_point_lots l on l.id=h.lot_id
  join jsonb_to_recordset(p_ranges) as r("offset" integer,points integer)
   on h.point_offset<r."offset"+r.points and r."offset"<h.point_offset+h.points
  where h.order_id=p_order group by l.id order by l.id
 loop
  update private.membership_point_lots set remaining=remaining+restored.points where id=restored.id;
  insert into private.membership_point_ledger(source,user_id,order_id,kind,points,expires_at)
  values('restore/'||p_operation||'/'||restored.id,buying_order.user_id,p_order,'restored',restored.points,restored.expires_at);
 end loop;
 if p_earned>0 then
  update private.membership_point_earnings set remaining_points=remaining_points-p_earned where order_id=p_order;
  if earning.credited_at is not null then
   -- Unused points from this earning cover the clawback even after expiry.
   -- Points held by another checkout stay reserved until that order resolves.
   if earning.credited_lot_id is not null then
    select coalesce((
     select least(p_earned,points) from private.membership_unheld_lots(buying_order.user_id,earning.credited_lot_id)
    ),0) into debited;
    update private.membership_point_lots set remaining=remaining-debited
    where id=earning.credited_lot_id and debited>0;
   end if;
   if debited<p_earned then
    debited:=debited+private.take_membership_points(buying_order.user_id,p_earned-debited,null);
    update private.membership_point_accounts set debt=debt+p_earned-debited where user_id=buying_order.user_id;
   end if;
  end if;
  insert into private.membership_point_ledger(source,user_id,order_id,kind,points)
  values('clawback/'||p_operation,buying_order.user_id,p_order,'clawed_back',-p_earned);
 end if;
end $$;

create or replace function public.admin_bulk_deliver_orders(p_actor uuid, p_orders jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare
 item record;
 current_order jsonb;
 buyer uuid;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then
  raise exception using errcode='42501';
 end if;
 if jsonb_typeof(p_orders) is distinct from 'array' then
  raise exception using errcode='22023';
 end if;
 if jsonb_array_length(p_orders) not between 1 and 100 then
  raise exception using errcode='22023';
 end if;
 if (select count(distinct id) from jsonb_to_recordset(p_orders) as entry(id uuid)) <> jsonb_array_length(p_orders) then
  raise exception using errcode='22023';
 end if;

 -- Acquire all order locks first, then each affected wallet in buyer order.
 perform 1 from public.orders o
 join jsonb_to_recordset(p_orders) as entry(id uuid) on entry.id=o.id order by o.id for update of o;
 for buyer in
  select distinct o.user_id from public.orders o
  join jsonb_to_recordset(p_orders) as entry(id uuid) on entry.id=o.id where o.member_points_eligible
  order by o.user_id
 loop
  perform private.lock_membership_point_account(buyer);
 end loop;
 for item in
  select * from jsonb_to_recordset(p_orders) as entry(id uuid, version integer) order by id
 loop
  current_order:=public.read_order_json(item.id);
  if (current_order->>'version')::integer is distinct from item.version
   or current_order->>'payment_status' is distinct from 'paid'
   or current_order->>'fulfilment_status' is distinct from 'Shipped' then
   raise exception using errcode='40001', message='ORDER_CHANGED';
  end if;
  perform public.admin_update_order(p_actor,item.id,item.version,'Delivered',current_order->>'tracking_number');
 end loop;
 return jsonb_array_length(p_orders);
end $$;

revoke all on function private.member_points_eligible(uuid,timestamptz,boolean),
 private.lock_membership_point_account(uuid),private.membership_unheld_lots(uuid,bigint),
 private.membership_points_summary(uuid,boolean),private.take_membership_points(uuid,integer,uuid),
 private.quote_points_coupon(uuid,timestamptz,boolean,text,text),
 private.apply_points_quote(uuid,timestamptz,boolean,integer,jsonb),
 private.membership_points_multiplier(uuid),private.resolve_order_membership_points(),
 private.apply_membership_points_refund(uuid,uuid,integer,jsonb)
 from public,anon,authenticated,service_role;

revoke all on function public.read_member_points(uuid),public.read_admin_member_points(uuid,text),
 public.adjust_member_points(uuid,uuid,integer,text,uuid),
 public.quote_points_checkout(uuid,timestamptz,boolean,text,text,integer),
 public.create_points_order(uuid,uuid,timestamptz,boolean,text,text,integer,integer)
 from public,anon,authenticated;
grant execute on function public.read_member_points(uuid),public.read_admin_member_points(uuid,text),
 public.adjust_member_points(uuid,uuid,integer,text,uuid),
 public.quote_points_checkout(uuid,timestamptz,boolean,text,text,integer),
 public.create_points_order(uuid,uuid,timestamptz,boolean,text,text,integer,integer)
 to service_role;

commit;
