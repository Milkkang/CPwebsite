begin;
set local lock_timeout='5s';

create table private.member_campaigns (
 id uuid primary key default gen_random_uuid(),
 title text not null check (title=trim(title) and char_length(title) between 1 and 100),
 kind text not null check (kind in ('fixed','percent')),
 amount integer not null check (amount>0 and (kind<>'percent' or amount<=100)),
 minimum_cents integer not null check (minimum_cents>=0),
 starts_at timestamptz not null,
 expires_at timestamptz not null check (expires_at>starts_at),
 audience text not null check (audience in ('all','new','returning')),
 member_limit integer not null check (member_limit>0),
 total_limit integer not null check (total_limit>=member_limit),
 active boolean not null default false,
 version integer not null default 1
);
create table private.member_campaign_redemptions (
 order_id uuid primary key,
 campaign_id uuid not null references private.member_campaigns(id),
 user_id uuid not null,
 live_payment boolean not null,
 state text not null default 'reserved' check (state in ('reserved','used','released')),
 reserved_at timestamptz not null default now(),
 resolved_at timestamptz,
 foreign key(order_id,user_id) references public.orders(id,user_id) on delete cascade,
 check ((state='reserved')=(resolved_at is null))
);
alter table private.member_campaigns enable row level security;
alter table private.member_campaign_redemptions enable row level security;
revoke all on private.member_campaigns,private.member_campaign_redemptions from public,anon,authenticated,service_role;
create index member_campaign_capacity_idx on private.member_campaign_redemptions(campaign_id,live_payment,user_id)
 include(state) where state in ('reserved','used');
create index member_campaign_pending_idx on private.member_campaign_redemptions(user_id,live_payment)
 where state='reserved';
create index member_campaign_recovery_idx on private.member_campaign_redemptions(reserved_at)
 where state='reserved';

create function private.member_campaign_terms(c private.member_campaigns)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',c.id,'title',c.title,'type',c.kind,'amount',c.amount,
  'minimum',c.minimum_cents,'startsAt',c.starts_at,'expiresAt',c.expires_at)
$$;

create function private.member_campaign_admin_view(c private.member_campaigns)
returns jsonb language sql stable set search_path='' as $$
 select private.member_campaign_terms(c)||jsonb_build_object('audience',c.audience,
  'memberLimit',c.member_limit,'totalLimit',c.total_limit,'active',c.active,'version',c.version,
  'redeemed',count(*) filter (where r.live_payment and r.state='used'),
  'reserved',count(*) filter (where r.live_payment and r.state='reserved'),
  'testRedeemed',count(*) filter (where not r.live_payment and r.state='used'),
  'testReserved',count(*) filter (where not r.live_payment and r.state='reserved'))
 from private.member_campaign_redemptions r where r.campaign_id=c.id and r.state in ('reserved','used')
$$;

create function public.read_member_campaigns(p_actor uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 return coalesce((select jsonb_agg(private.member_campaign_admin_view(c) order by c.starts_at desc,c.id)
  from private.member_campaigns c),'[]'::jsonb);
end $$;

create function public.save_member_campaign(p_actor uuid,p_id uuid,p_version integer,p_campaign jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.member_campaigns;
 next_member_limit integer:=(p_campaign->>'memberLimit')::integer;
 next_total_limit integer:=(p_campaign->>'totalLimit')::integer;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 if p_id is null and p_version=0 then
  insert into private.member_campaigns(title,kind,amount,minimum_cents,starts_at,expires_at,audience,member_limit,total_limit,active)
  values(p_campaign->>'title',p_campaign->>'type',(p_campaign->>'amount')::integer,(p_campaign->>'minimum')::integer,
   (p_campaign->>'startsAt')::timestamptz,(p_campaign->>'expiresAt')::timestamptz,p_campaign->>'audience',
   next_member_limit,next_total_limit,(p_campaign->>'active')::boolean) returning * into c;
 else
  select * into c from private.member_campaigns where id=p_id and version=p_version for update;
  if not found then raise exception using errcode='PT409',message='CAMPAIGN_CHANGED'; end if;
  if (next_member_limit<c.member_limit and exists(select 1 from private.member_campaign_redemptions r
    where r.campaign_id=p_id and r.state in ('reserved','used') group by r.live_payment,r.user_id having count(*)>next_member_limit))
   or (next_total_limit<c.total_limit and exists(select 1 from private.member_campaign_redemptions r
    where r.campaign_id=p_id and r.state in ('reserved','used') group by r.live_payment having count(*)>next_total_limit)) then
   raise exception using errcode='PT409',message='CAMPAIGN_LIMIT_IN_USE';
  end if;
  update private.member_campaigns set title=p_campaign->>'title',kind=p_campaign->>'type',
   amount=(p_campaign->>'amount')::integer,minimum_cents=(p_campaign->>'minimum')::integer,
   starts_at=(p_campaign->>'startsAt')::timestamptz,expires_at=(p_campaign->>'expiresAt')::timestamptz,
   audience=p_campaign->>'audience',member_limit=next_member_limit,total_limit=next_total_limit,
   active=(p_campaign->>'active')::boolean,version=version+1 where id=p_id returning * into c;
 end if;
 return private.member_campaign_admin_view(c);
end $$;

create function private.member_campaign_eligible(c private.member_campaigns,p_user uuid,p_live boolean)
returns boolean language sql stable set search_path='' as $$
 select c.active and now()>=c.starts_at and now()<c.expires_at
 and (c.audience='all' or (c.audience='returning')=exists(select 1 from public.orders o where o.user_id=p_user
  and o.live_payment and (o.paid_at is not null or o.payment_status in ('paid','refunded'))))
 and (select count(*)<c.total_limit and count(*) filter (where r.user_id=p_user)<c.member_limit
  from private.member_campaign_redemptions r where r.campaign_id=c.id and r.live_payment=p_live and r.state in ('reserved','used'))
$$;

-- Sandbox member checkout supports the same resume/cancel controls for both coupon sources.
create or replace function private.release_unattached_welcome_order(p_user uuid,p_live boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare abandoned_id uuid;
begin
 for abandoned_id in select o.id from public.orders o where o.user_id=p_user and o.live_payment=p_live
  and o.payment_status='pending' and o.stripe_checkout_session_id is null and o.created_at<=now()-interval '5 minutes'
  and (exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id and w.state='reserved')
    or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id and r.state='reserved'))
  order by o.id for update of o
 loop
  perform public.release_test_order(abandoned_id);
 end loop;
end $$;

-- A checkout URL is returned only after attachment. Reclaim one abandoned
-- reservation per scheduled call, with an order lock to exclude a concurrent attachment.
create function public.release_stale_member_campaign_order()
returns boolean language plpgsql security definer set search_path='' as $$
declare abandoned_id uuid;
begin
 select o.id into abandoned_id from private.member_campaign_redemptions r
 join public.orders o on o.id=r.order_id where r.state='reserved' and r.reserved_at<=now()-interval '5 minutes'
  and o.payment_status='pending' and o.stripe_checkout_session_id is null
 order by r.reserved_at,r.order_id limit 1 for update of o skip locked;
 if not found then return false; end if;
 return public.release_test_order(abandoned_id);
end $$;

create or replace function public.read_membership(p_user uuid,p_launch timestamptz,p_live boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare membership jsonb; campaigns jsonb;
begin
 perform private.release_unattached_welcome_order(p_user,p_live);
 membership:=private.membership_status(p_user,p_launch,p_live);
 if membership->>'enabled'='true' then
  select jsonb_agg(private.member_campaign_terms(c) order by c.expires_at,c.id) into campaigns
  from private.member_campaigns c where private.member_campaign_eligible(c,p_user,p_live);
 end if;
 return membership||jsonb_build_object('campaigns',coalesce(campaigns,'[]'::jsonb));
end $$;

create function private.member_campaign_discount(c private.member_campaigns,p_user uuid,p_launch timestamptz,
 p_live boolean,p_subtotal integer,p_shipping integer)
returns integer language plpgsql stable set search_path='' as $$
declare discount integer;
begin
 if p_launch is null or now()<p_launch or private.member_campaign_eligible(c,p_user,p_live) is distinct from true
  or not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null
   and deleted_at is null and (banned_until is null or banned_until<=now())) then
  raise exception using errcode='PT409',message='CAMPAIGN_UNAVAILABLE';
 end if;
 if p_subtotal<c.minimum_cents then raise exception using errcode='PT409',message='CAMPAIGN_MINIMUM'; end if;
 discount:=case when c.kind='fixed' then c.amount else round(p_subtotal::numeric*c.amount/100)::integer end;
 return greatest(0,least(discount,p_subtotal,p_subtotal+p_shipping-50));
end $$;

create function public.quote_campaign_checkout(p_user uuid,p_campaign uuid,p_launch timestamptz,p_live boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare subtotal integer; item_count integer; valid_count integer; shipping integer; discount integer; c private.member_campaigns;
begin
 select count(*),count(*) filter (where p.status='Published' and i.quantity between p.min_quantity and p.available_quantity),
  coalesce(sum(p.price_cents*i.quantity),0) into item_count,valid_count,subtotal
 from public.buyer_cart_items i join public.products p on p.sku=i.sku where i.user_id=p_user;
 if item_count=0 or item_count<>valid_count then raise exception using errcode='PT409',message='CART_CHANGED'; end if;
 select case when subtotal>=d.free_threshold_cents then 0 else d.shipping_cents end into shipping
 from public.delivery_rules d where d.country_code='SG' and d.active order by d.id limit 1;
 if shipping is null then raise exception using errcode='PT409',message='DELIVERY_UNAVAILABLE'; end if;
 select * into c from private.member_campaigns where id=p_campaign;
 discount:=private.member_campaign_discount(c,p_user,p_launch,p_live,subtotal,shipping);
 return jsonb_build_object('subtotal',subtotal,'shipping',shipping,'discount',discount,'total',subtotal+shipping-discount);
end $$;

create function public.create_campaign_order(p_user uuid,p_address uuid,p_campaign uuid,p_launch timestamptz,
 p_live boolean,p_expected_total integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare created jsonb; checkout_id uuid; subtotal integer; shipping integer; discount integer; total integer;
 item_subtotal integer; valid_items boolean; c private.member_campaigns;
begin
 if p_live then
  created:=public.create_live_order(p_user,p_address,null);
 else
  perform pg_advisory_xact_lock(hashtextextended('welcome-checkout:'||p_user,0));
  perform private.release_unattached_welcome_order(p_user,false);
  if public.read_pending_welcome_checkout(p_user) is not null then
   raise exception using errcode='PT409',message='CHECKOUT_PENDING';
  end if;
  created:=public.create_test_order(p_user,p_address,null);
 end if;
 checkout_id:=(created->>'id')::uuid;
 subtotal:=(created->>'subtotal_cents')::integer;
 shipping:=(created->>'shipping_cents')::integer;
 select sum(i.unit_cents*i.quantity),bool_and(p.status='Published' and i.quantity>=p.min_quantity and i.unit_cents=p.price_cents)
 into item_subtotal,valid_items from public.order_items i join public.products p on p.sku=i.sku where i.order_id=checkout_id;
 if valid_items is distinct from true or item_subtotal is distinct from subtotal then
  raise exception using errcode='PT409',message='CART_CHANGED';
 end if;
 -- Checkout already holds inventory locks. Serialize campaign claims and admin edits
 -- here, then calculate capacity from a fresh snapshot under the campaign row lock.
 select * into c from private.member_campaigns where id=p_campaign for update;
 discount:=private.member_campaign_discount(c,p_user,p_launch,p_live,subtotal,shipping);
 total:=subtotal+shipping-discount;
 if total is distinct from p_expected_total then raise exception using errcode='PT409',message='CART_CHANGED'; end if;
 update public.orders set discount_cents=discount,total_cents=total where id=checkout_id;
 insert into private.member_campaign_redemptions(order_id,campaign_id,user_id,live_payment)
 values(checkout_id,p_campaign,p_user,p_live);
 return public.read_order_json(checkout_id,p_user);
end $$;

create function private.resolve_member_campaign_redemption()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update private.member_campaign_redemptions
 set state=case when new.payment_status='paid' then 'used' else 'released' end,resolved_at=now()
 where order_id=new.id and state='reserved';
 return null;
end $$;
create trigger resolve_member_campaign_redemption after update of payment_status on public.orders
 for each row when (old.payment_status='pending' and new.payment_status in ('paid','failed','expired'))
 execute function private.resolve_member_campaign_redemption();

create or replace function public.read_pending_welcome_checkout(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',o.id,'stripe_checkout_session_id',o.stripe_checkout_session_id)
 from public.orders o where o.user_id=p_user and not o.live_payment and o.payment_status='pending'
 and (exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id and w.state='reserved')
  or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id and r.state='reserved'))
 order by o.created_at,o.id limit 1
$$;

create or replace function public.cancel_welcome_checkout(p_user uuid,p_order uuid,p_session text)
returns boolean language plpgsql security definer set search_path='' as $$
declare current_status public.order_payment_status;
begin
 select o.payment_status into current_status from public.orders o
 where o.id=p_order and o.user_id=p_user and not o.live_payment and o.stripe_checkout_session_id=p_session
 and (exists(select 1 from private.welcome_coupon_reservations w where w.order_id=o.id)
  or exists(select 1 from private.member_campaign_redemptions r where r.order_id=o.id)) for update of o;
 if not found then return false; end if;
 if current_status='failed' then return true; end if;
 if not public.release_test_order(p_order) then return false; end if;
 perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 return true;
end $$;

-- Match the one-open-member-checkout rule when starting with the welcome coupon.
create function private.require_open_member_checkout()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not new.live_payment and exists(select 1 from private.member_campaign_redemptions r
  where r.user_id=new.user_id and not r.live_payment and r.state='reserved') then
  raise exception using errcode='PT409',message='CHECKOUT_PENDING';
 end if;
 return new;
end $$;
create trigger require_open_member_checkout before insert on private.welcome_coupon_reservations
 for each row execute function private.require_open_member_checkout();

revoke all on function private.member_campaign_terms(private.member_campaigns),
 private.member_campaign_admin_view(private.member_campaigns),private.member_campaign_eligible(private.member_campaigns,uuid,boolean),
 private.member_campaign_discount(private.member_campaigns,uuid,timestamptz,boolean,integer,integer),
 private.resolve_member_campaign_redemption(),private.require_open_member_checkout() from public,anon,authenticated,service_role;
revoke all on function public.read_member_campaigns(uuid),public.save_member_campaign(uuid,uuid,integer,jsonb),
 public.quote_campaign_checkout(uuid,uuid,timestamptz,boolean),public.create_campaign_order(uuid,uuid,uuid,timestamptz,boolean,integer),
 public.release_stale_member_campaign_order()
 from public,anon,authenticated;
grant execute on function public.read_member_campaigns(uuid),public.save_member_campaign(uuid,uuid,integer,jsonb),
 public.quote_campaign_checkout(uuid,uuid,timestamptz,boolean),public.create_campaign_order(uuid,uuid,uuid,timestamptz,boolean,integer),
 public.release_stale_member_campaign_order()
 to service_role;

commit;
