-- Durable, service-only test operations. No real funds or destructive data changes.
create table public.order_operations (
 order_id uuid references public.orders(id), actor_id uuid not null references auth.users(id),
 action text not null check(action in ('cancel','refund')), restock boolean not null,
 status text not null default 'pending' check(status in ('pending','completed','aborted')),
 provider_id text, created_at timestamptz not null default now(), completed_at timestamptz, primary key(order_id,action)
);
alter table public.order_operations enable row level security;
revoke all on public.order_operations from public,anon,authenticated;
grant all on public.order_operations to service_role;

-- Extend the existing durable outbox to every test-order notification kind.
alter table public.email_confirmation_outbox drop constraint email_confirmation_outbox_kind_check;
alter table public.email_confirmation_outbox add constraint email_confirmation_outbox_kind_check
 check(kind in ('order_confirmation','cancellation','shipment','delivery','test_refund'));
grant select,insert,update on public.email_confirmation_outbox to service_role;
create function public.queue_test_order_notice(p_order uuid,p_kind public.email_job_kind,p_source text)
returns void language plpgsql security invoker set search_path='' as $$
declare job uuid;
begin
 insert into public.email_confirmation_outbox(event_id,order_id,kind) values(p_source,p_order,p_kind)
 on conflict(event_id) do nothing;
 begin
  job:=public.enqueue_order_email(p_order,p_kind,'stripe/'||p_source);
  if job is not null then update public.email_confirmation_outbox set enqueued_at=now(),last_error_code=null where event_id=p_source;end if;
 exception when others then
  update public.email_confirmation_outbox set last_error_code=sqlstate where event_id=p_source;
 end;
end $$;
revoke all on function public.queue_test_order_notice(uuid,public.email_job_kind,text) from public,anon,authenticated;
grant execute on function public.queue_test_order_notice(uuid,public.email_job_kind,text) to service_role;

create function public.prepare_test_order_operation(p_actor uuid,p_order uuid,p_version integer,p_action text,p_restock boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.orders; op public.order_operations;
begin
 if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then raise exception using errcode='22023',message='INVALID_ORDER'; end if;
 select * into op from public.order_operations where order_id=p_order and action=p_action;
 if found then
  if op.action<>p_action or op.restock<>p_restock then raise exception using errcode='22023',message='OPERATION_CHANGED'; end if;
 else
  if o.version<>p_version then raise exception using errcode='40001'; end if;
  if p_action='cancel' and (o.payment_status<>'pending' or o.fulfilment_status<>'Processing') or
     p_action='refund' and (o.payment_status<>'paid' or o.stripe_payment_intent_id is null) or
     p_action not in ('cancel','refund') or p_action is null or p_restock is null then
    raise exception using errcode='22023',message='INVALID_OPERATION';
  end if;
  insert into public.order_operations(order_id,actor_id,action,restock) values(p_order,p_actor,p_action,p_restock) returning * into op;
 end if;
 return jsonb_build_object('completed',op.status='completed','session',o.stripe_checkout_session_id,
   'intent',o.stripe_payment_intent_id,'amount',o.total_cents,'currency',o.currency);
end $$;

create function public.finish_test_order_operation(p_actor uuid,p_order uuid,p_action text,p_provider text)
returns boolean language plpgsql security invoker set search_path='' as $$
declare o public.orders; op public.order_operations; item record; before_stock integer;
begin
 if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 select * into op from public.order_operations where order_id=p_order and action=p_action for update;
 if not found or nullif(p_provider,'') is null then raise exception using errcode='22023'; end if;
 if op.status='completed' then return true; end if;
 if op.action='cancel' and p_provider='checkout_completed' then
  update public.order_operations set status='aborted',completed_at=now() where order_id=p_order and action=p_action;
  return false;
 end if;
 if op.action='cancel' then
  if o.payment_status<>'pending' then raise exception using errcode='40001'; end if;
  perform public.release_test_order(p_order);
  perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 else
  if o.payment_status<>'paid' or p_provider !~ '^re_' then raise exception using errcode='40001'; end if;
  if op.restock then
   for item in select * from public.order_items where order_id=p_order order by sku loop
    select stock into before_stock from public.products where sku=item.sku for update;
    update public.products set stock=stock+item.quantity,version=version+1 where sku=item.sku;
    insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key,actor_id)
    values(item.sku,before_stock,item.quantity,before_stock+item.quantity,'test_refund','refund:'||p_order||':'||item.sku,p_actor);
   end loop;
  end if;
  update public.orders set payment_status='refunded',fulfilment_status='Cancelled',version=version+1,updated_at=now() where id=p_order;
  perform public.queue_test_order_notice(p_order,'test_refund','refund/'||p_order);
  perform public.queue_test_order_notice(p_order,'cancellation','refund-cancellation/'||p_order);
 end if;
 update public.order_operations set status='completed',provider_id=p_provider,completed_at=now() where order_id=p_order and action=p_action;
 return true;
end $$;

-- Lock ordering agrees with payment and fulfilment RPCs (order first).
create function public.guard_order_operation() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from public.order_operations where order_id=old.id and status='pending' and action='refund') and
    (new.fulfilment_status in ('Shipped','Delivered')) then
  raise exception using errcode='40001',message='ORDER_OPERATION_PENDING';
 end if;
 return new;
end $$;
create trigger guard_order_operation before update on public.orders for each row execute function public.guard_order_operation();
revoke all on function public.prepare_test_order_operation(uuid,uuid,integer,text,boolean),public.finish_test_order_operation(uuid,uuid,text,text),public.guard_order_operation() from public,anon,authenticated;
grant execute on function public.prepare_test_order_operation(uuid,uuid,integer,text,boolean),public.finish_test_order_operation(uuid,uuid,text,text) to service_role;

-- An entire import commits or rolls back together, including stock ledger entries.
create function public.admin_import_products(p_actor uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare item jsonb; n integer:=0;
begin
 if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 1000 then raise exception using errcode='22023'; end if;
 if (select count(distinct value->>'sku') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) then raise exception using errcode='22023',message='DUPLICATE_SKU'; end if;
 for item in select value from jsonb_array_elements(p_rows) order by value->>'sku' loop
  perform public.admin_write_product(p_actor,item->>'sku',(item->>'version')::bigint,item->'fields',(item->>'stock')::integer);
  n:=n+1;
 end loop;
 insert into public.import_runs(id,dataset_hash,expected_listings) values('admin:'||gen_random_uuid(),md5(p_rows::text),n);
 return n;
end $$;
revoke all on function public.admin_import_products(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_import_products(uuid,jsonb) to service_role;
