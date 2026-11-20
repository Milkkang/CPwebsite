-- Notify only a verified failed or expired Stripe test Checkout Session.
-- Reuse the durable payment-email outbox so an email failure never undoes release.
begin;

alter table public.email_confirmation_outbox
 add column kind public.email_job_kind not null default 'order_confirmation',
 add constraint email_confirmation_outbox_kind_check check (kind in ('order_confirmation','cancellation'));

create or replace function public.enqueue_order_email(p_order uuid,p_kind public.email_job_kind,p_source_key text)
returns uuid language plpgsql security definer set search_path=public,auth as $$
declare o public.orders; address text; job uuid; key text;
begin
 select * into o from public.orders where id=p_order;
 if not found or not (o.payment_status in ('paid','refunded') or
   (p_kind='cancellation' and o.payment_status='failed' and o.fulfilment_status='Cancelled')) then return null; end if;
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

create or replace function public.apply_test_payment_event(p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,p_amount integer,p_currency text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o public.orders; outcome text; job uuid; kind public.email_job_kind;
begin
 perform pg_advisory_xact_lock(hashtextextended('stripe:'||p_event,0));
 if exists(select 1 from public.stripe_webhook_events where event_id=p_event) then return jsonb_build_object('duplicate',true); end if;
 if p_livemode is distinct from false then raise exception using errcode='P0001',message='LIVE_MODE_REJECTED'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then outcome:='order_not_found';
 elsif p_type='checkout.session.completed' then
  if o.payment_status<>'pending' or o.stripe_checkout_session_id is distinct from p_session or o.total_cents is distinct from p_amount or p_currency is distinct from 'sgd' then outcome:='payment_mismatch';
  else
   insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key)
    select p.id,p.stock,-i.quantity,p.stock-i.quantity,'stripe_test_payment','stripe:'||p_event||':'||p.id from public.order_items i join public.products p on p.sku=i.sku where i.order_id=o.id;
   update public.products p set stock=p.stock-i.quantity,reserved_quantity=greatest(0,p.reserved_quantity-i.quantity),version=version+1
    from public.order_items i where i.order_id=o.id and i.sku=p.sku and p.stock>=i.quantity;
   update public.orders set payment_status='paid',stripe_payment_intent_id=nullif(p_intent,''),paid_at=now(),updated_at=now(),version=version+1 where id=o.id;
   delete from public.buyer_cart_items where user_id=o.user_id; outcome:='paid';
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
 insert into public.stripe_webhook_events(event_id,event_type,livemode,order_id,outcome) values(p_event,p_type,p_livemode,o.id,outcome);
 return jsonb_build_object('duplicate',false,'outcome',outcome);
end $$;

-- The existing Worker RPC now reconciles both confirmation and cancellation.
create or replace function public.reconcile_email_confirmations(p_limit integer default 25)
returns integer language plpgsql security definer set search_path=public as $$
declare item record; job uuid; total integer:=0;
begin
 for item in select event_id,order_id,kind from public.email_confirmation_outbox
   where enqueued_at is null order by created_at for update skip locked limit least(greatest(p_limit,1),25) loop
  begin
   job:=public.enqueue_order_email(item.order_id,item.kind,'stripe/'||item.event_id);
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

commit;
