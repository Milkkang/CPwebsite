-- One-off production acceptance action. Run only after the delivery template
-- Worker and Phase 6 delivery/cancellation migrations are live and verified.
-- It does not change the order, payment, stock, or recipient allowlist.
begin;

do $$
declare selected_order public.orders; expected_recipient_hash text; queued_job uuid;
begin
 select * into selected_order from public.orders where order_number=1005 for update;
 if not found or selected_order.payment_status<>'paid' or selected_order.fulfilment_status<>'Delivered' then
  raise exception 'CVM-1005 is not an eligible paid, delivered test order';
 end if;
 select public.email_recipient_hash(u.email) into expected_recipient_hash
 from auth.users u where u.id=selected_order.user_id and u.email is not null;
 if expected_recipient_hash is null or not exists (
  select 1 from public.email_jobs j where j.order_id=selected_order.id
   and j.kind='shipment' and j.status='delivered' and j.is_test
   and j.recipient_hash=expected_recipient_hash
 ) then raise exception 'CVM-1005 shipment delivery or recipient could not be verified'; end if;
 if exists(select 1 from public.email_jobs j where j.order_id=selected_order.id and j.kind='delivery') then
  raise exception 'CVM-1005 already has a delivery email task';
 end if;
 queued_job:=public.enqueue_order_email(selected_order.id,'delivery','manual/cvm-1005/20261120');
 if queued_job is null then raise exception 'CVM-1005 delivery email was not queued'; end if;
end $$;

commit;
