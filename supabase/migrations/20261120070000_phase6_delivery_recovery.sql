-- Forward-only recovery for Phase 6. Existing orders, jobs and audit rows remain intact.
begin;

create table public.email_confirmation_outbox (
  event_id text primary key,
  order_id uuid not null references public.orders(id),
  enqueued_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now()
);
create index email_confirmation_outbox_pending_idx on public.email_confirmation_outbox(created_at) where enqueued_at is null;
alter table public.email_confirmation_outbox enable row level security;
revoke all on public.email_confirmation_outbox from public,anon,authenticated;

create unique index email_jobs_one_manual_child_idx on public.email_jobs(parent_job_id) where parent_job_id is not null;
create index email_delivery_events_unmatched_idx on public.email_delivery_events(provider_message_id) where job_id is null;

-- Reconcile all known events for a message. The state ordering makes late or
-- out-of-order delivery events unable to undo a bounce or complaint.
create function public.reconcile_email_delivery_events(p_job uuid)
returns void language plpgsql security definer set search_path=public as $$
declare job public.email_jobs; final_status public.email_job_status;
begin
 select * into job from public.email_jobs where id=p_job for update;
 if not found or job.provider_message_id is null then return; end if;
 update public.email_delivery_events set job_id=job.id
 where provider_message_id=job.provider_message_id and job_id is null;
 select case
   when bool_or(event_type='email.complained') then 'complained'::public.email_job_status
   when bool_or(event_type='email.bounced') then 'bounced'::public.email_job_status
   when bool_or(event_type='email.delivered') then 'delivered'::public.email_job_status
   when bool_or(event_type='email.failed') then 'failed'::public.email_job_status
   else null end into final_status
 from public.email_delivery_events where provider_message_id=job.provider_message_id;
 if final_status is not null and
    (job.status in ('sent','failed','delivered','bounced','complained')) and
    (case job.status when 'complained' then 4 when 'bounced' then 3
      when 'delivered' then 2 when 'failed' then 1 else 0 end)
    < (case final_status when 'complained' then 4 when 'bounced' then 3
      when 'delivered' then 2 when 'failed' then 1 else 0 end) then
  update public.email_jobs set status=final_status,
   last_error_code=case when final_status='failed' then 'PROVIDER_DELIVERY_FAILED' else null end,
   updated_at=now() where id=job.id;
 end if;
 if final_status in ('bounced','complained') then
  insert into public.email_suppressions(recipient_hash,reason,provider_message_id)
  values(job.recipient_hash,case when final_status='complained' then 'complained' else 'bounced' end,job.provider_message_id)
  on conflict(recipient_hash) do update set
   reason=case when excluded.reason='complained' then 'complained' else public.email_suppressions.reason end,
   provider_message_id=excluded.provider_message_id,updated_at=now();
 end if;
end $$;

create or replace function public.apply_email_delivery_event(p_event text,p_message text,p_type text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job_id uuid; inserted text;
begin
 select id into job_id from public.email_jobs where provider_message_id=p_message for update;
 insert into public.email_delivery_events(event_id,provider_message_id,event_type,job_id)
 values(p_event,p_message,p_type,job_id) on conflict(event_id) do nothing returning event_id into inserted;
 if inserted is null then return jsonb_build_object('duplicate',true); end if;
 if job_id is not null then perform public.reconcile_email_delivery_events(job_id); end if;
 return jsonb_build_object('duplicate',false,'matched',job_id is not null);
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
  perform public.reconcile_email_delivery_events(p_job);
 else
  delay:=case p_attempt when 1 then interval '1 minute' when 2 then interval '5 minutes' else interval '30 minutes' end;
  update public.email_jobs set status=case when p_retryable and p_attempt<4 then 'pending'::public.email_job_status else 'failed'::public.email_job_status end,
   next_attempt_at=now()+delay,last_error_code=left(p_error,80),updated_at=now() where id=p_job;
 end if;
 return true;
end $$;

create or replace function public.claim_email_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; orphan record;
begin
 -- A Worker that exits during its last attempt must reach a terminal state.
 with expired as (
  update public.email_jobs set status='failed',last_error_code='WORKER_LEASE_EXHAUSTED',updated_at=now()
  where status='sending' and updated_at<now()-interval '5 minutes' and attempt_count>=4
  returning id,attempt_count
 ) insert into public.email_job_attempts(job_id,attempt,outcome,error_code)
   select id,attempt_count,'failed','WORKER_LEASE_EXHAUSTED' from expired
   on conflict(job_id,attempt) do nothing;
 update public.email_jobs set status='pending',next_attempt_at=now(),last_error_code='WORKER_LEASE_EXPIRED',updated_at=now()
 where status='sending' and updated_at<now()-interval '5 minutes' and attempt_count<4;
 -- A callback may commit just after the send result. Recheck unmatched events.
 for orphan in select distinct j.id from public.email_delivery_events e
   join public.email_jobs j on j.provider_message_id=e.provider_message_id
   where e.job_id is null limit 25 loop
  perform public.reconcile_email_delivery_events(orphan.id);
 end loop;
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

create or replace function public.admin_resend_email(p_actor uuid,p_job uuid)
returns uuid language plpgsql security definer set search_path=public as $$
declare old public.email_jobs; new_id uuid:=gen_random_uuid(); result uuid;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into old from public.email_jobs where id=p_job and status in ('failed','bounced') for update;
 if not found or exists(select 1 from public.email_suppressions where recipient_hash=old.recipient_hash and reason='complained') then
  raise exception using errcode='P0001',message='RESEND_NOT_ALLOWED';
 end if;
 insert into public.email_jobs(id,order_id,kind,recipient,recipient_hash,payload,is_test,idempotency_key,parent_job_id,override_bounce_suppression)
 values(new_id,old.order_id,old.kind,old.recipient,old.recipient_hash,old.payload,old.is_test,'manual/'||old.id||'/'||new_id,old.id,true)
 on conflict do nothing returning id into result;
 return coalesce(result,(select id from public.email_jobs where parent_job_id=old.id));
end $$;

-- A paid Stripe event and its outbox record commit before email creation. An
-- email-only failure is retried by the scheduled Worker without replaying pay.
create or replace function public.apply_test_payment_event(p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; outcome text; job uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('stripe:'||p_event,0));
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
   insert into public.email_confirmation_outbox(event_id,order_id) values(p_event,o.id);
   begin
    job:=public.enqueue_order_email(o.id,'order_confirmation','stripe/'||p_event);
    if job is not null then
     update public.email_confirmation_outbox set enqueued_at=now() where event_id=p_event;
    else
     update public.email_confirmation_outbox set last_error_code='NO_RECIPIENT' where event_id=p_event;
    end if;
   exception when others then
    update public.email_confirmation_outbox set last_error_code=sqlstate where event_id=p_event;
   end;
  end if;
 elsif p_type in ('checkout.session.expired','checkout.session.async_payment_failed') then perform public.release_test_order(o.id); outcome:='released';
 else outcome:='ignored'; end if;
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

create function public.reconcile_email_confirmations(p_limit integer default 25)
returns integer language plpgsql security definer set search_path=public as $$
declare item record; job uuid; total integer:=0;
begin
 for item in select event_id,order_id from public.email_confirmation_outbox
   where enqueued_at is null order by created_at for update skip locked limit least(greatest(p_limit,1),25) loop
  begin
   job:=public.enqueue_order_email(item.order_id,'order_confirmation','stripe/'||item.event_id);
   if job is not null then
    update public.email_confirmation_outbox set enqueued_at=now(),last_error_code=null where event_id=item.event_id;
    total:=total+1;
   else
    update public.email_confirmation_outbox set last_error_code='NO_RECIPIENT' where event_id=item.event_id;
   end if;
  exception when others then
   update public.email_confirmation_outbox set last_error_code=sqlstate where event_id=item.event_id;
  end;
 end loop;
 return total;
end $$;

revoke all on function public.reconcile_email_delivery_events(uuid),public.reconcile_email_confirmations(integer) from public,anon,authenticated;
grant execute on function public.reconcile_email_delivery_events(uuid),public.reconcile_email_confirmations(integer) to service_role;
commit;
