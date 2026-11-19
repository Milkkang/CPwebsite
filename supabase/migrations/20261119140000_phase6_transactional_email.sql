-- Phase 6 transactional email. All orders remain Stripe sandbox test orders.
create type public.email_job_kind as enum ('order_confirmation','shipment','cancellation','test_refund');
create type public.email_job_status as enum ('pending','sending','sent','delivered','bounced','complained','failed');

create table public.email_jobs (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id),
  kind public.email_job_kind not null, recipient text not null check(length(recipient) between 3 and 254),
  recipient_hash text not null check(recipient_hash ~ '^[a-f0-9]{64}$'), payload jsonb not null default '{}'::jsonb,
  is_test boolean not null default true, idempotency_key text not null unique check(length(idempotency_key) between 1 and 256),
  status public.email_job_status not null default 'pending', attempt_count integer not null default 0 check(attempt_count between 0 and 4),
  next_attempt_at timestamptz not null default now(), provider_message_id text,
  last_error_code text, parent_job_id uuid references public.email_jobs(id), override_bounce_suppression boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), sent_at timestamptz
);
create table public.email_job_attempts (
  id bigint generated always as identity primary key, job_id uuid not null references public.email_jobs(id),
  attempt integer not null check(attempt between 1 and 4), outcome text not null,
  error_code text, created_at timestamptz not null default now(), unique(job_id,attempt)
);
create table public.email_delivery_events (
  event_id text primary key, provider_message_id text not null, event_type text not null,
  job_id uuid references public.email_jobs(id), processed_at timestamptz not null default now()
);
create table public.email_suppressions (
  recipient_hash text primary key check(recipient_hash ~ '^[a-f0-9]{64}$'), reason text not null check(reason in ('bounced','complained')),
  provider_message_id text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index email_jobs_due_idx on public.email_jobs(status,next_attempt_at) where status='pending';
create index email_jobs_order_idx on public.email_jobs(order_id,created_at desc);
alter table public.email_jobs enable row level security;
alter table public.email_job_attempts enable row level security;
alter table public.email_delivery_events enable row level security;
alter table public.email_suppressions enable row level security;

create or replace function public.email_recipient_hash(p_recipient text)
returns text language sql immutable set search_path=public as $$
 select encode(extensions.digest(lower(trim(p_recipient)),'sha256'),'hex')
$$;

create or replace function public.enqueue_order_email(p_order uuid,p_kind public.email_job_kind,p_source_key text)
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare o public.orders; address text; job uuid; key text;
begin
 select * into o from public.orders where id=p_order;
 if not found or o.payment_status not in ('paid','refunded') then return null; end if;
 select lower(u.email) into address from auth.users u where u.id=o.user_id and u.email is not null;
 if address is null then return null; end if;
 key:=p_kind::text||'/'||p_source_key;
 insert into public.email_jobs(order_id,kind,recipient,recipient_hash,payload,is_test,idempotency_key)
 values(o.id,p_kind,address,public.email_recipient_hash(address),
   jsonb_build_object('orderNumber','CVM-'||o.order_number,'total',o.total_cents,'currency',o.currency,
     'tracking',case when p_kind='shipment' then o.tracking_number else '' end),true,key)
 on conflict(idempotency_key) do nothing returning id into job;
 return coalesce(job,(select id from public.email_jobs where idempotency_key=key));
end $$;

create or replace function public.claim_email_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 update public.email_jobs set status='pending',next_attempt_at=now(),last_error_code='WORKER_LEASE_EXPIRED',updated_at=now()
 where status='sending' and updated_at<now()-interval '5 minutes' and attempt_count<4;
 with due as (
  select j.id from public.email_jobs j left join public.email_suppressions s on s.recipient_hash=j.recipient_hash
  where j.status='pending' and j.next_attempt_at<=now() and j.attempt_count<4
    and (s.recipient_hash is null or (s.reason='bounced' and j.override_bounce_suppression))
  order by j.next_attempt_at,j.created_at for update of j skip locked limit least(greatest(p_limit,1),25)
 ), claimed as (
  update public.email_jobs j set status='sending',attempt_count=attempt_count+1,updated_at=now()
  from due where j.id=due.id
  returning j.id,j.order_id,j.kind,j.recipient,j.payload,j.is_test,j.idempotency_key,j.attempt_count
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) into result from claimed;
 return result;
end $$;

create or replace function public.finish_email_attempt(p_job uuid,p_attempt integer,p_success boolean,p_provider_id text,p_error text,p_retryable boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare delay interval;
begin
 if not exists(select 1 from public.email_jobs where id=p_job and status='sending' and attempt_count=p_attempt for update) then return false; end if;
 insert into public.email_job_attempts(job_id,attempt,outcome,error_code)
 values(p_job,p_attempt,case when p_success then 'sent' when p_retryable and p_attempt<4 then 'retry' else 'failed' end,left(p_error,80));
 if p_success then
  update public.email_jobs set status='sent',provider_message_id=left(p_provider_id,200),last_error_code=null,sent_at=now(),updated_at=now() where id=p_job;
 else
  delay:=case p_attempt when 1 then interval '1 minute' when 2 then interval '5 minutes' else interval '30 minutes' end;
  update public.email_jobs set status=case when p_retryable and p_attempt<4 then 'pending'::public.email_job_status else 'failed'::public.email_job_status end,
   next_attempt_at=now()+delay,last_error_code=left(p_error,80),updated_at=now() where id=p_job;
 end if;
 return true;
end $$;

create or replace function public.apply_email_delivery_event(p_event text,p_message text,p_type text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.email_jobs; mapped public.email_job_status;
begin
 if exists(select 1 from public.email_delivery_events where event_id=p_event) then return jsonb_build_object('duplicate',true); end if;
 select * into job from public.email_jobs where provider_message_id=p_message for update;
 mapped:=case p_type when 'email.delivered' then 'delivered'::public.email_job_status when 'email.bounced' then 'bounced'::public.email_job_status
   when 'email.complained' then 'complained'::public.email_job_status when 'email.failed' then 'failed'::public.email_job_status else null end;
 insert into public.email_delivery_events(event_id,provider_message_id,event_type,job_id) values(p_event,p_message,p_type,job.id);
 if job.id is not null and mapped='complained' then
  update public.email_jobs set status=mapped,updated_at=now() where id=job.id;
 elsif job.id is not null and mapped='bounced' and job.status<>'complained' then
  update public.email_jobs set status=mapped,updated_at=now() where id=job.id;
 elsif job.id is not null and mapped='delivered' and job.status='sent' then
  update public.email_jobs set status=mapped,updated_at=now() where id=job.id;
 elsif job.id is not null and mapped='failed' and job.status='sent' then
  update public.email_jobs set status=mapped,last_error_code='PROVIDER_DELIVERY_FAILED',updated_at=now() where id=job.id;
 end if;
 if job.id is not null and p_type in ('email.bounced','email.complained') then
  insert into public.email_suppressions(recipient_hash,reason,provider_message_id)
  values(job.recipient_hash,case when p_type='email.complained' then 'complained' else 'bounced' end,p_message)
  on conflict(recipient_hash) do update set reason=case when excluded.reason='complained' then 'complained' else public.email_suppressions.reason end,
    provider_message_id=excluded.provider_message_id,updated_at=now();
 end if;
 return jsonb_build_object('duplicate',false,'matched',job.id is not null);
end $$;

create or replace function public.read_admin_email_jobs(p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'orderId',j.order_id,'kind',j.kind,'status',j.status,
  'recipient',regexp_replace(j.recipient,'(^.).*(@.*$)','\1***\2'),'attempts',j.attempt_count,'error',j.last_error_code,
  'createdAt',j.created_at,'updatedAt',j.updated_at) order by j.created_at desc),'[]'::jsonb)
 into result from public.email_jobs j;
 return result;
end $$;

create or replace function public.admin_resend_email(p_actor uuid,p_job uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare old public.email_jobs; fresh uuid:=gen_random_uuid();
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into old from public.email_jobs where id=p_job and status in ('failed','bounced') for update;
 if not found or exists(select 1 from public.email_suppressions where recipient_hash=old.recipient_hash and reason='complained') then
  raise exception using errcode='P0001',message='RESEND_NOT_ALLOWED';
 end if;
 insert into public.email_jobs(id,order_id,kind,recipient,recipient_hash,payload,is_test,idempotency_key,parent_job_id,override_bounce_suppression)
 values(fresh,old.order_id,old.kind,old.recipient,old.recipient_hash,old.payload,old.is_test,'manual/'||old.id||'/'||fresh,old.id,true);
 return fresh;
end $$;

-- Replace Phase 5 payment application so successful payment and confirmation enqueue commit together.
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
    select p.id,p.stock,-i.quantity,p.stock-i.quantity,'stripe_test_payment','stripe:'||p_event||':'||p.id from public.order_items i join public.products p on p.sku=i.sku where i.order_id=o.id;
   update public.products p set stock=p.stock-i.quantity,reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
    from public.order_items i where i.order_id=o.id and i.sku=p.sku and p.stock>=i.quantity;
   update public.orders set payment_status='paid',stripe_payment_intent_id=nullif(p_intent,''),paid_at=now(),updated_at=now(),version=version+1 where id=o.id;
   delete from public.buyer_cart_items where user_id=o.user_id; outcome:='paid';
   perform public.enqueue_order_email(o.id,'order_confirmation','stripe/'||p_event);
  end if;
 elsif p_type in ('checkout.session.expired','checkout.session.async_payment_failed') then perform public.release_test_order(o.id); outcome:='released';
 else outcome:='ignored'; end if;
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

-- Replace the existing fulfilment update so the first Shipped transition queues one shipment email.
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
 if previous='Processing' and p_status='Shipped' then perform public.enqueue_order_email(o.id,'shipment','order/'||o.id||'/version/'||o.version); end if;
 return public.read_order_json(o.id,null);
end $$;

revoke all on public.email_jobs,public.email_job_attempts,public.email_delivery_events,public.email_suppressions from public,anon,authenticated;
revoke all on function public.email_recipient_hash(text),public.enqueue_order_email(uuid,public.email_job_kind,text),public.claim_email_jobs(integer),
 public.finish_email_attempt(uuid,integer,boolean,text,text,boolean),public.apply_email_delivery_event(text,text,text),
 public.read_admin_email_jobs(uuid),public.admin_resend_email(uuid,uuid) from public,anon,authenticated;
grant execute on function public.enqueue_order_email(uuid,public.email_job_kind,text),public.claim_email_jobs(integer),
 public.finish_email_attempt(uuid,integer,boolean,text,text,boolean),public.apply_email_delivery_event(text,text,text),
 public.read_admin_email_jobs(uuid),public.admin_resend_email(uuid,uuid) to service_role;
