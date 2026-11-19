-- Run only in a disposable PostgreSQL database after applying all migrations.
create function public.phase6_test_reject_enqueue() returns trigger language plpgsql as $$
begin
 if new.idempotency_key like '%evt_payment_email_failure%' then raise exception 'synthetic email enqueue failure'; end if;
 return new;
end $$;


do $$
begin
 if has_function_privilege('anon','public.reconcile_email_confirmations(integer)','EXECUTE') or
    has_function_privilege('authenticated','public.reconcile_email_confirmations(integer)','EXECUTE') or
    has_function_privilege('anon','public.reconcile_email_delivery_events(uuid)','EXECUTE') then
  raise exception 'new service functions are callable by clients';
 end if;
 if not has_function_privilege('service_role','public.reconcile_email_confirmations(integer)','EXECUTE') then
  raise exception 'service role cannot reconcile outbox';
 end if;
 if has_table_privilege('anon','public.email_confirmation_outbox','SELECT') or
    not (select relrowsecurity from pg_class where oid='public.email_confirmation_outbox'::regclass) then
  raise exception 'outbox is visible to clients';
 end if;
end $$;

create trigger phase6_test_reject_enqueue before insert on public.email_jobs
for each row execute function public.phase6_test_reject_enqueue();

do $$
declare user_id uuid:=gen_random_uuid(); address_id uuid:=gen_random_uuid();
 first_order_id uuid; second_order uuid; payment jsonb; confirmation_job_id uuid;
 first_resend uuid; second_resend uuid; message_id text:='synthetic-message-1';
begin
 insert into auth.users(id,email,email_confirmed_at) values(user_id,'acceptance@example.invalid',now());
 insert into public.admin_roles(user_id) values(user_id);
 insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
 values(address_id,user_id,'Acceptance User','Test Street 1','123456');
 insert into public.categories(id,name) values('acceptance','Acceptance');
 insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,reserved_quantity,status)
 values('TEST-1','TEST-1','Acceptance Item','One','Test','acceptance','https://example.invalid/a.jpg','https://example.invalid/a.jpg','https://example.invalid/a.jpg',1000,10,2,'Published');
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id)
 values(user_id,address_id,1000,0,0,1000,'cs_test_phase6_1') returning id into first_order_id;
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity)
 values(first_order_id,'TEST-1','Acceptance Item','One',1000,1);
 payment:=public.apply_test_payment_event('evt_phase6_1','checkout.session.completed',false,first_order_id,'cs_test_phase6_1','pi_test_phase6_1',1000,'sgd');
 if payment->>'outcome'<>'paid' then raise exception 'payment did not commit'; end if;
 if (select count(*) from public.email_jobs j where j.order_id=first_order_id)<>1 then raise exception 'confirmation missing'; end if;
 if (select count(*) from public.inventory_movements where source_key like 'stripe:evt_phase6_1:%')<>1 then raise exception 'inventory not applied once'; end if;
 payment:=public.apply_test_payment_event('evt_phase6_1','checkout.session.completed',false,first_order_id,'cs_test_phase6_1','pi_test_phase6_1',1000,'sgd');
 if payment->>'duplicate'<>'true' then raise exception 'Stripe replay not deduplicated'; end if;
 if (select count(*) from public.inventory_movements where source_key like 'stripe:evt_phase6_1:%')<>1 then raise exception 'duplicate inventory movement'; end if;
 select id into confirmation_job_id from public.email_jobs where idempotency_key='order_confirmation/stripe/evt_phase6_1';
 if not exists(select 1 from public.email_confirmation_outbox where event_id='evt_phase6_1' and enqueued_at is not null) then raise exception 'outbox missing'; end if;
 perform public.claim_email_jobs(10);
 -- Callback arrives before the provider message ID is stored.
 perform public.apply_email_delivery_event('event_early_delivered',message_id,'email.delivered');
 perform public.apply_email_delivery_event('event_early_bounced',message_id,'email.bounced');
 if not public.finish_email_attempt(confirmation_job_id,1,true,message_id,'',false) then raise exception 'finish failed'; end if;
 if (select status from public.email_jobs where id=confirmation_job_id)<>'bounced' then raise exception 'early bounce not reconciled'; end if;
 if (select count(*) from public.email_delivery_events where provider_message_id=message_id and job_id=confirmation_job_id)<>2 then raise exception 'events not matched'; end if;
 if not exists(select 1 from public.email_suppressions where recipient_hash=public.email_recipient_hash('acceptance@example.invalid') and reason='bounced') then raise exception 'bounce suppression missing'; end if;
 perform public.apply_email_delivery_event('event_early_delivered',message_id,'email.delivered');
 if (select count(*) from public.email_delivery_events where provider_message_id=message_id)<>2 then raise exception 'duplicate event audited'; end if;
 perform public.apply_email_delivery_event('event_late_complaint',message_id,'email.complained');
 if (select status from public.email_jobs where id=confirmation_job_id)<>'complained' then raise exception 'complaint did not prevail'; end if;
 -- A second, synthetic test order proves enqueue failure cannot roll back pay.
 insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id)
 values(user_id,address_id,1000,0,0,1000,'cs_test_phase6_2') returning id into second_order;
 insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity)
 values(second_order,'TEST-1','Acceptance Item','One',1000,1);
 payment:=public.apply_test_payment_event('evt_payment_email_failure','checkout.session.completed',false,second_order,'cs_test_phase6_2','pi_test_phase6_2',1000,'sgd');
 if payment->>'outcome'<>'paid' or (select payment_status from public.orders where id=second_order)<>'paid' then raise exception 'email failure rolled back pay'; end if;
 if not exists(select 1 from public.email_confirmation_outbox where event_id='evt_payment_email_failure' and enqueued_at is null and last_error_code is not null) then raise exception 'outbox did not retain failure'; end if;
end $$;


drop trigger phase6_test_reject_enqueue on public.email_jobs;
drop function public.phase6_test_reject_enqueue();

do $$
declare test_order uuid; admin_id uuid; first_resend uuid; second_resend uuid; retry_job uuid;
begin
 if public.reconcile_email_confirmations(25)<>1 then raise exception 'outbox recovery did not enqueue'; end if;
 if not exists(select 1 from public.email_confirmation_outbox where event_id='evt_payment_email_failure' and enqueued_at is not null) then raise exception 'outbox not marked recovered'; end if;
 select order_id into test_order from public.email_confirmation_outbox where event_id='evt_payment_email_failure';
 if (select count(*) from public.email_jobs where order_id=test_order)<>1 then raise exception 'recovery created duplicate job'; end if;
 if public.reconcile_email_confirmations(25)<>0 then raise exception 'outbox recovery repeated'; end if;
 select user_id into admin_id from public.orders where id=test_order;
 select id into retry_job from public.email_jobs where order_id=test_order;
 update public.email_jobs set status='sending',attempt_count=4,updated_at=now()-interval '6 minutes' where id=retry_job;
 perform public.claim_email_jobs(10);
 if (select status from public.email_jobs where id=retry_job)<>'failed' or
    (select last_error_code from public.email_jobs where id=retry_job)<>'WORKER_LEASE_EXHAUSTED' then raise exception 'final lease stayed stuck'; end if;
 if (select count(*) from public.email_job_attempts where job_id=retry_job and attempt=4)<>1 then raise exception 'last attempt not audited'; end if;
 begin
  perform public.admin_resend_email(admin_id,retry_job);
  raise exception 'complaint suppression was bypassed';
 exception when sqlstate 'P0001' then null;
 end;
 delete from public.email_suppressions where recipient_hash=public.email_recipient_hash('acceptance@example.invalid');
 first_resend:=public.admin_resend_email(admin_id,retry_job);
 second_resend:=public.admin_resend_email(admin_id,retry_job);
 if first_resend<>second_resend or (select count(*) from public.email_jobs where parent_job_id=retry_job)<>1 then raise exception 'duplicate admin resend'; end if;
end $$;

do $$
declare test_order uuid; retry_job uuid; expected_key text; claim jsonb; step integer;
 expected_delay integer; actual_delay numeric;
begin
 select order_id into test_order from public.email_confirmation_outbox where event_id='evt_phase6_1';
 retry_job:=public.enqueue_order_email(test_order,'test_refund','acceptance/retry');
 select idempotency_key into expected_key from public.email_jobs where id=retry_job;
 for step in 1..4 loop
  claim:=public.claim_email_jobs(10);
  if not exists(select 1 from jsonb_array_elements(claim) item where item->>'id'=retry_job::text
    and item->>'idempotency_key'=expected_key and (item->>'attempt_count')::integer=step) then
   raise exception 'retry claim % missing or changed idempotency key',step;
  end if;
  perform public.finish_email_attempt(retry_job,step,false,'','RESEND_HTTP_429',true);
  if step<4 then
   expected_delay:=case step when 1 then 60 when 2 then 300 else 1800 end;
   select extract(epoch from next_attempt_at-now()) into actual_delay from public.email_jobs where id=retry_job;
   if actual_delay<expected_delay-5 or actual_delay>expected_delay+5 then raise exception 'retry delay % was %',step,actual_delay; end if;
   update public.email_jobs set next_attempt_at=now()-interval '1 second' where id=retry_job;
  end if;
 end loop;
 if (select status from public.email_jobs where id=retry_job)<>'failed' or
    (select attempt_count from public.email_jobs where id=retry_job)<>4 or
    (select count(*) from public.email_job_attempts where job_id=retry_job)<>4 then
  raise exception 'retry did not stop after four attempts';
 end if;
end $$;

do $$
declare test_order uuid; delivery_job uuid; claimed jsonb;
begin
 select order_id into test_order from public.email_confirmation_outbox where event_id='evt_phase6_1';
 delivery_job:=public.enqueue_order_email(test_order,'cancellation','acceptance/event-order');
 claimed:=public.claim_email_jobs(10);
 if not exists(select 1 from jsonb_array_elements(claimed) item where item->>'id'=delivery_job::text) then
  raise exception 'delivery order job not claimed';
 end if;
 perform public.finish_email_attempt(delivery_job,1,true,'synthetic-message-2','',false);
 perform public.apply_email_delivery_event('event_failed_2','synthetic-message-2','email.failed');
 if (select status from public.email_jobs where id=delivery_job)<>'failed' then raise exception 'failed event ignored'; end if;
 perform public.apply_email_delivery_event('event_delivered_2','synthetic-message-2','email.delivered');
 if (select status from public.email_jobs where id=delivery_job)<>'delivered' then raise exception 'delivery did not supersede failure'; end if;
 perform public.apply_email_delivery_event('event_bounced_2','synthetic-message-2','email.bounced');
 perform public.apply_email_delivery_event('event_delivered_late_2','synthetic-message-2','email.delivered');
 if (select status from public.email_jobs where id=delivery_job)<>'bounced' then raise exception 'late delivery overrode bounce'; end if;
end $$;

do $$
declare test_order uuid; admin_id uuid; initial_version integer;
begin
 select o.id,o.user_id,o.version into test_order,admin_id,initial_version
 from public.orders o join public.email_confirmation_outbox x on x.order_id=o.id
 where x.event_id='evt_phase6_1';
 perform public.admin_update_order(admin_id,test_order,initial_version,'Shipped','TRACK-TEST-1');
 if (select count(*) from public.email_jobs where order_id=test_order and kind='shipment')<>1 then
  raise exception 'first shipped transition did not enqueue exactly once';
 end if;
 perform public.admin_update_order(admin_id,test_order,initial_version+1,'Shipped','TRACK-TEST-1');
 if (select count(*) from public.email_jobs where order_id=test_order and kind='shipment')<>1 then
  raise exception 'repeated shipped save enqueued another email';
 end if;
end $$;
