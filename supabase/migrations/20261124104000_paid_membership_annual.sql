-- Annual fees are separate from merchandise orders and from spending tiers.
create table public.paid_membership_purchases (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 livemode boolean not null,
 amount_cents integer not null default 1990 check (amount_cents = 1990),
 currency text not null default 'sgd' check (currency = 'sgd'),
 return_origin text not null,
 terms_accepted_at timestamptz not null default clock_timestamp(),
 checkout_expires_at timestamptz not null,
 status text not null default 'pending' check (status in ('pending','paid','expired','failed')),
 stripe_checkout_session_id text unique,
 stripe_payment_intent_id text unique,
 paid_at timestamptz,
 starts_at timestamptz,
 expires_at timestamptz,
 check (
  (status='paid' and stripe_checkout_session_id is not null and stripe_payment_intent_id is not null
   and paid_at is not null and starts_at is not null and expires_at is not null and starts_at<expires_at)
  or (status<>'paid' and stripe_payment_intent_id is null and paid_at is null and starts_at is null and expires_at is null)
 )
);

create unique index paid_membership_one_pending
 on public.paid_membership_purchases(user_id,livemode) where status='pending';
create index paid_membership_periods
 on public.paid_membership_purchases(user_id,livemode,starts_at desc) where status='paid';
create index paid_membership_purchases_owner on public.paid_membership_purchases(user_id);

create table public.paid_membership_events (
 event_id text primary key,
 purchase_id uuid not null references public.paid_membership_purchases(id),
 event_type text not null,
 provider_created_at timestamptz not null,
 recorded_at timestamptz not null default clock_timestamp()
);

create index paid_membership_events_purchase on public.paid_membership_events(purchase_id);
alter table public.paid_membership_purchases enable row level security;
alter table public.paid_membership_events enable row level security;
revoke all on public.paid_membership_purchases, public.paid_membership_events from public,anon,authenticated,service_role;
grant select,insert,update on public.paid_membership_purchases to service_role;
grant select,insert on public.paid_membership_events to service_role;

-- One period at a trusted instant. False is sandbox only, including on a
-- database shared with the sandbox. An adjoining renewal takes over at expiry.
create function public.active_paid_membership_period(p_user uuid,p_livemode boolean,p_at timestamptz)
returns table(purchase_id uuid,starts_at timestamptz,expires_at timestamptz)
language sql stable set search_path='' as $$
 select p.id,p.starts_at,p.expires_at
 from public.paid_membership_purchases p
 where p.user_id=p_user and p.livemode=p_livemode and p.status='paid'
  and p.starts_at<=p_at and p_at<p.expires_at
 order by p.starts_at desc limit 1;
$$;

create function public.read_paid_membership(p_user uuid,p_livemode boolean,p_purchase uuid)
returns jsonb language plpgsql stable set search_path='' as $$
declare
 current_time_at timestamptz:=statement_timestamp();
 latest public.paid_membership_purchases%rowtype;
 current_period record;
 purchase_status text;
 pending boolean;
begin
 select p.* into latest from public.paid_membership_purchases p
 where p.user_id=p_user and p.livemode=p_livemode and p.status='paid'
 order by p.starts_at desc limit 1;

 select * into current_period from public.active_paid_membership_period(p_user,p_livemode,current_time_at);

 select exists(
  select from public.paid_membership_purchases p where p.user_id=p_user and p.livemode=p_livemode and p.status='pending'
   and (p.stripe_checkout_session_id is not null or p.checkout_expires_at>current_time_at)
 ) into pending;
 select case when p.status='pending' and p.stripe_checkout_session_id is null and p.checkout_expires_at<=current_time_at
  then 'expired' else p.status end into purchase_status
 from public.paid_membership_purchases p where p.id=p_purchase and p.user_id=p_user and p.livemode=p_livemode;

 return jsonb_build_object(
  'status',case when current_period.purchase_id is not null then 'active' when latest.id is not null then 'expired' else 'none' end,
  'period',case when current_period.purchase_id is not null
    then jsonb_build_object('startsAt',current_period.starts_at,'expiresAt',current_period.expires_at)
    when latest.id is not null then jsonb_build_object('startsAt',latest.starts_at,'expiresAt',latest.expires_at) end,
  'nextPeriod',case when latest.starts_at>current_time_at
    then jsonb_build_object('startsAt',latest.starts_at,'expiresAt',latest.expires_at) end,
  'renewableAt',case when latest.expires_at>current_time_at
    then latest.expires_at-interval '720 hours' end,
  'canPurchase',latest.id is null or latest.expires_at<=current_time_at+interval '720 hours',
  'pendingCheckout',pending,'purchaseStatus',purchase_status);
end;
$$;

create function public.prepare_paid_membership_checkout(p_user uuid,p_livemode boolean,p_origin text)
returns jsonb language plpgsql set search_path='' as $$
declare
 purchase public.paid_membership_purchases%rowtype;
 checked_at timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('paid_membership:'||p_user::text||':'||p_livemode::text,0));
 checked_at:=clock_timestamp();
 -- An unattached Checkout URL has never been issued to the buyer. An attached
 -- one needs definitive provider expiry or failure, even past the local deadline.
 update public.paid_membership_purchases set status='expired'
 where user_id=p_user and livemode=p_livemode and status='pending'
  and stripe_checkout_session_id is null and checkout_expires_at<=checked_at;

 select p.* into purchase from public.paid_membership_purchases p
 where p.user_id=p_user and p.livemode=p_livemode and p.status='pending';
 if not found then
  if exists(select from public.paid_membership_purchases p
    where p.user_id=p_user and p.livemode=p_livemode and p.status='paid'
     and p.expires_at>checked_at+interval '720 hours') then
   raise exception 'ANNUAL_PASS_NOT_RENEWABLE' using errcode='23514';
  end if;
  insert into public.paid_membership_purchases(user_id,livemode,return_origin,checkout_expires_at)
  values(p_user,p_livemode,p_origin,date_trunc('second',checked_at)+interval '1 hour')
  returning * into purchase;
 end if;
 return jsonb_build_object('id',purchase.id,'origin',purchase.return_origin,
  'expiresAt',extract(epoch from purchase.checkout_expires_at)::bigint,'sessionId',purchase.stripe_checkout_session_id);
end;
$$;

create function public.attach_paid_membership_checkout(p_user uuid,p_livemode boolean,p_purchase uuid,p_session text)
returns boolean language plpgsql set search_path='' as $$
begin
 if p_session is null or p_session !~ ((case when p_livemode then '^cs_live_' else '^cs_test_' end)||'[A-Za-z0-9_]{1,200}$')
  then return false; end if;
 update public.paid_membership_purchases set stripe_checkout_session_id=p_session
 where id=p_purchase and user_id=p_user and livemode=p_livemode and status='pending'
  and (stripe_checkout_session_id=p_session or stripe_checkout_session_id is null and checkout_expires_at>clock_timestamp());
 return found;
end;
$$;

-- Used only after the Worker retrieves the proper session in expired/unpaid
-- state from Stripe, in case the signed expiry callback has not arrived.
create function public.expire_paid_membership_checkout(p_user uuid,p_livemode boolean,p_purchase uuid,p_session text)
returns boolean language plpgsql set search_path='' as $$
begin
 update public.paid_membership_purchases set status='expired',stripe_checkout_session_id=p_session
 where id=p_purchase and user_id=p_user and livemode=p_livemode and status in ('pending','expired')
  and p_session ~ ((case when p_livemode then '^cs_live_' else '^cs_test_' end)||'[A-Za-z0-9_]{1,200}$')
  and (stripe_checkout_session_id is null or stripe_checkout_session_id=p_session);
 return found;
end;
$$;

create function public.apply_paid_membership_event(p_event text,p_type text,p_livemode boolean,p_purchase uuid,p_user uuid,
 p_session text,p_intent text,p_amount integer,p_currency text,p_event_at timestamptz)
returns jsonb language plpgsql set search_path='' as $$
declare
 purchase public.paid_membership_purchases%rowtype;
 paid_event boolean:=p_type in ('checkout.session.completed','checkout.session.async_payment_succeeded');
 period_start timestamptz;
begin
 if p_event is null or p_event !~ '^evt_[A-Za-z0-9_]{1,200}$' or p_type is null
  or p_type not in ('checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired','checkout.session.async_payment_failed')
  or p_user is null or p_livemode is null or p_session is null
  or p_session !~ ((case when p_livemode then '^cs_live_' else '^cs_test_' end)||'[A-Za-z0-9_]{1,200}$')
  or p_event_at is null or p_event_at>clock_timestamp()+interval '5 minutes'
  or (paid_event and (p_intent is null or p_intent !~ '^pi_[A-Za-z0-9_]{1,200}$')) then
  raise exception 'ANNUAL_PASS_PAYMENT_MISMATCH' using errcode='23514';
 end if;

 perform pg_advisory_xact_lock(hashtextextended('paid_membership:'||p_user::text||':'||p_livemode::text,0));
 select p.* into purchase from public.paid_membership_purchases p
 where p.id=p_purchase and p.user_id=p_user and p.livemode=p_livemode for update;
 if not found or p_amount is distinct from purchase.amount_cents or p_currency is distinct from purchase.currency
  or p_event_at<date_trunc('second',purchase.terms_accepted_at)
  or (paid_event or purchase.stripe_checkout_session_id is not null)
    and p_session is distinct from purchase.stripe_checkout_session_id then
  raise exception 'ANNUAL_PASS_PAYMENT_MISMATCH' using errcode='23514';
 end if;

 insert into public.paid_membership_events(event_id,purchase_id,event_type,provider_created_at)
 values(p_event,purchase.id,p_type,p_event_at) on conflict(event_id) do nothing;
 if not found then
  if not exists(select from public.paid_membership_events e where e.event_id=p_event and e.purchase_id=purchase.id
    and e.event_type=p_type and e.provider_created_at=p_event_at) then
   raise exception 'ANNUAL_PASS_PAYMENT_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('status',purchase.status,'duplicate',true);
 end if;

 if purchase.status='paid' then
  if paid_event and p_intent is distinct from purchase.stripe_payment_intent_id then
   raise exception 'ANNUAL_PASS_PAYMENT_MISMATCH' using errcode='23514';
  end if;
  return jsonb_build_object('status','paid','duplicate',true);
 end if;

 if not paid_event then
  if purchase.status='pending' then
   update public.paid_membership_purchases set stripe_checkout_session_id=p_session,
    status=case when p_type='checkout.session.expired' then 'expired' else 'failed' end
   where id=purchase.id returning status into purchase.status;
  end if;
  return jsonb_build_object('status',purchase.status);
 end if;

 if purchase.status<>'pending' then
  raise exception 'ANNUAL_PASS_PAYMENT_MISMATCH' using errcode='23514';
 end if;
 select greatest(p_event_at,max(p.expires_at)) into period_start from public.paid_membership_purchases p
 where p.user_id=p_user and p.livemode=p_livemode and p.status='paid';

 update public.paid_membership_purchases set status='paid',stripe_payment_intent_id=p_intent,paid_at=p_event_at,
  starts_at=period_start,
  expires_at=((period_start at time zone 'Asia/Singapore')+interval '12 months') at time zone 'Asia/Singapore'
 where id=purchase.id;
 return jsonb_build_object('status','paid');
end;
$$;

revoke execute on function public.active_paid_membership_period(uuid,boolean,timestamptz),
 public.read_paid_membership(uuid,boolean,uuid),public.prepare_paid_membership_checkout(uuid,boolean,text),
 public.attach_paid_membership_checkout(uuid,boolean,uuid,text),public.expire_paid_membership_checkout(uuid,boolean,uuid,text),
 public.apply_paid_membership_event(text,text,boolean,uuid,uuid,text,text,integer,text,timestamptz)
from public,anon,authenticated;
grant execute on function public.active_paid_membership_period(uuid,boolean,timestamptz),
 public.read_paid_membership(uuid,boolean,uuid),public.prepare_paid_membership_checkout(uuid,boolean,text),
 public.attach_paid_membership_checkout(uuid,boolean,uuid,text),public.expire_paid_membership_checkout(uuid,boolean,uuid,text),
 public.apply_paid_membership_event(text,text,boolean,uuid,uuid,text,text,integer,text,timestamptz)
to service_role;
