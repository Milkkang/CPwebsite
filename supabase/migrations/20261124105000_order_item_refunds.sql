begin;
set local lock_timeout='5s';

alter table public.orders
 add column refunded_cents integer not null default 0,
 add column refunded_merchandise_cents integer not null default 0,
 add constraint order_refund_cash_limit check (refunded_cents between 0 and total_cents),
 add constraint order_refund_merchandise_limit check (
  refunded_merchandise_cents between 0 and least(refunded_cents,greatest(0,subtotal_cents-discount_cents))
 );
alter table public.order_items
 add column refunded_quantity integer not null default 0 check (refunded_quantity between 0 and quantity);

-- Historical full refunds retain their original operation and stock audit.
update public.orders set refunded_cents=total_cents,refunded_merchandise_cents=greatest(0,subtotal_cents-discount_cents)
where payment_status='refunded';
update public.order_items i set refunded_quantity=i.quantity from public.orders o
where i.order_id=o.id and o.payment_status='refunded';

create table private.order_refunds (
 id uuid primary key,
 order_id uuid not null references public.orders(id),
 actor_id uuid not null references auth.users(id),
 request_items jsonb check (request_items is null or jsonb_typeof(request_items)='array'),
 item_allocations jsonb not null check (jsonb_typeof(item_allocations)='array'),
 restock boolean not null,
 legacy boolean not null,
 cash_cents integer not null check (cash_cents>=0),
 merchandise_cents integer not null check (merchandise_cents between 0 and cash_cents),
 status text not null default 'pending' check (status in ('pending','completed','aborted')),
 provider_id text unique,
 provider_status text,
 resolved_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 resolved_at timestamptz
);
create index order_refunds_order_idx on private.order_refunds(order_id);
create unique index order_refunds_one_pending_idx on private.order_refunds(order_id) where status='pending';
alter table private.order_refunds enable row level security;
revoke all on private.order_refunds from public,anon,authenticated,service_role;

-- Match the historical Stripe line ordering and JavaScript Math.round for
-- pre-snapshot orders. The float subtraction preserves values just below .5.
create function private.legacy_refund_reduction(p_discount integer,p_through bigint,p_subtotal integer)
returns integer language sql immutable set search_path='' as $$
 select floor(value)::integer+((value-floor(value))>=0.5)::integer
 from (select coalesce(p_discount*(p_through::double precision/nullif(p_subtotal,0)),0) as value) price
$$;

create function private.order_refund_allocations(p_order public.orders,p_items jsonb)
returns jsonb language sql stable set search_path='' as $$
 with original as (
  select i.sku,i.quantity,i.refunded_quantity,i.unit_cents,
   sum(i.unit_cents::bigint*i.quantity) over (order by i.sku)::bigint gross_through,
   coalesce(l.cash_cents,0) snapshot_cash,coalesce(l.point_cents,0) points,
   coalesce(l.point_offset,0) point_offset,coalesce(l.cash_offset,0) cash_offset,
   coalesce(e.multiplier,0) multiplier
  from public.order_items i
  left join private.membership_order_lines l on l.order_id=i.order_id and l.sku=i.sku
  left join private.membership_point_earnings e on e.order_id=i.order_id
  where i.order_id=p_order.id
 ), requested as (
  select o.*,coalesce(r.quantity,o.quantity-o.refunded_quantity) return_qty,
   case when p_order.member_points_eligible then snapshot_cash else unit_cents*o.quantity
    -private.legacy_refund_reduction(least(p_order.discount_cents,p_order.subtotal_cents),gross_through,p_order.subtotal_cents)
    +private.legacy_refund_reduction(least(p_order.discount_cents,p_order.subtotal_cents),
      gross_through-unit_cents::bigint*o.quantity,p_order.subtotal_cents) end line_cash
  from original o left join jsonb_to_recordset(p_items) as r(sku text,quantity integer) using(sku)
  where r.quantity is not null or p_items is null and o.refunded_quantity<o.quantity
 ), unit_costs as (
  select *,round(line_cash::numeric*refunded_quantity/quantity)::integer cash_start,
   round(line_cash::numeric*(refunded_quantity+return_qty)/quantity)::integer cash_end
  from requested
 ), unit_points as (
  select *,coalesce(round(points::numeric*(unit_cents::bigint*refunded_quantity-cash_start)/
   nullif(unit_cents::bigint*quantity-line_cash,0)),0)::integer points_start,
   coalesce(round(points::numeric*(unit_cents::bigint*(refunded_quantity+return_qty)-cash_end)/
   nullif(unit_cents::bigint*quantity-line_cash,0)),0)::integer points_end
  from unit_costs
 )
 select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'quantity',return_qty,'cash',cash_end-cash_start,
  'coupon',unit_cents::bigint*return_qty-(cash_end-cash_start)-(points_end-points_start),
  'points',points_end-points_start,'offset',point_offset+points_start,
  'earned',((cash_offset::bigint+cash_end)*multiplier/10000)-((cash_offset::bigint+cash_start)*multiplier/10000)
 ) order by sku collate "C"),'[]'::jsonb)
 from unit_points
$$;

create function public.prepare_order_refund(
 p_actor uuid,p_order uuid,p_version integer,p_request uuid,p_restock boolean,p_live boolean,p_items jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 o public.orders; op private.order_refunds; old_op public.order_operations;
 items jsonb; allocations jsonb; merchandise integer; amount integer;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found or o.live_payment is distinct from p_live then
  raise exception using errcode='22023',message='PAYMENT_MODE_MISMATCH';
 end if;
 if p_restock is null then raise exception using errcode='22023',message='INVALID_REFUND'; end if;

 if p_items is not null then
  if jsonb_typeof(p_items)<>'array' then raise exception using errcode='22023',message='INVALID_REFUND_ITEMS'; end if;
  if jsonb_array_length(p_items) not between 1 and 200 or exists (
   select 1 from jsonb_array_elements(p_items) AS r
   where jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'sku') is distinct from 'string'
    or nullif(r->>'sku','') is null or char_length(r->>'sku')>200
    or jsonb_typeof(r->'quantity') is distinct from 'number' or (r->>'quantity') !~ '^[1-9][0-9]{0,9}$'
    or case when (r->>'quantity') ~ '^[1-9][0-9]{0,9}$' then (r->>'quantity')::bigint>2147483647 else true end
  ) or (select count(distinct r->>'sku') from jsonb_array_elements(p_items) r)<>jsonb_array_length(p_items) then
   raise exception using errcode='22023',message='INVALID_REFUND_ITEMS';
  end if;
  select jsonb_agg(jsonb_build_object('sku',r->>'sku','quantity',(r->>'quantity')::integer) order by (r->>'sku') collate "C")
  into items from jsonb_array_elements(p_items) r;
 end if;

 if p_request is not null then
  select * into op from private.order_refunds where id=p_request;
 elsif items is null then
  select * into op from private.order_refunds where order_id=p_order and legacy;
 end if;
 if op.id is not null then
  if (op.order_id,op.restock,op.request_items) is distinct from (p_order,p_restock,items) then
   raise exception using errcode='PT409',message='REFUND_REQUEST_CHANGED';
  end if;
 else
  select * into old_op from public.order_operations where order_id=p_order and action='refund';
  if old_op.status='completed' and p_request is null and items is null and old_op.restock=p_restock then
   return jsonb_build_object('completed',true,'amount',o.total_cents);
  end if;
  if old_op.status='pending' then
   if p_request is not null or items is not null or old_op.restock is distinct from p_restock then
    raise exception using errcode='PT409',message='REFUND_IN_PROGRESS';
   end if;
  elsif p_request is null then
   raise exception using errcode='22023',message='REFUND_REQUEST_REQUIRED';
  end if;
  if exists(select 1 from private.order_refunds where order_id=p_order and status='pending') then
   raise exception using errcode='PT409',message='REFUND_IN_PROGRESS';
  end if;
  if (old_op.status is distinct from 'pending' and o.version is distinct from p_version)
   or o.payment_status<>'paid' then raise exception using errcode='40001',message='ORDER_CHANGED'; end if;
  if exists (
   select 1 from jsonb_to_recordset(items) as r(sku text,quantity integer)
   left join public.order_items i on i.order_id=p_order and i.sku=r.sku
   where i.sku is null or r.quantity>i.quantity-i.refunded_quantity
  ) then raise exception using errcode='22023',message='REFUND_QUANTITY_UNAVAILABLE'; end if;
  if o.member_points_eligible and (
   not exists(select 1 from private.membership_point_earnings where order_id=p_order) or exists(
    select 1 from public.order_items i left join private.membership_order_lines l on l.order_id=i.order_id and l.sku=i.sku
    where i.order_id=p_order and l.sku is null
   )
  ) then raise exception using errcode='22023',message='REFUND_PRICING_UNAVAILABLE'; end if;

  allocations:=private.order_refund_allocations(o,items);
  if items is null then
   merchandise:=greatest(0,o.subtotal_cents-o.discount_cents)-o.refunded_merchandise_cents;
   amount:=o.total_cents-o.refunded_cents;
  else
   select coalesce(sum(a.cash),0) into merchandise from jsonb_to_recordset(allocations) as a(cash integer);
   amount:=merchandise;
  end if;
  if amount>o.total_cents-o.refunded_cents or merchandise>greatest(0,o.subtotal_cents-o.discount_cents)-o.refunded_merchandise_cents
   or amount>0 and coalesce(o.stripe_payment_intent_id,'') !~ '^pi_[A-Za-z0-9_]+$' then
   raise exception using errcode='22023',message='REFUND_PRICING_UNAVAILABLE';
  end if;

  insert into private.order_refunds(id,order_id,actor_id,request_items,item_allocations,restock,legacy,cash_cents,merchandise_cents)
  values(coalesce(p_request,gen_random_uuid()),p_order,coalesce(old_op.actor_id,p_actor),items,allocations,p_restock,
   old_op.status is not distinct from 'pending',amount,merchandise)
  returning * into op;
 end if;

 return jsonb_build_object('id',op.id,'completed',op.status='completed','aborted',op.status='aborted',
  'intent',o.stripe_payment_intent_id,'amount',op.cash_cents,'paidAmount',o.total_cents,'refunded',o.refunded_cents,
  'currency',o.currency,'legacy',op.legacy,
  'restored',(select coalesce(sum(a.points),0) from jsonb_to_recordset(op.item_allocations) as a(points integer)),
  'earned',(select coalesce(sum(a.earned),0) from jsonb_to_recordset(op.item_allocations) as a(earned integer)));
end $$;

-- Resume the stored intent only. An unknown client request must never begin a refund.
create function public.resume_order_refund(p_actor uuid,p_order uuid,p_request uuid,p_live boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare op private.order_refunds;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into op from private.order_refunds where id=p_request and order_id=p_order;
 if not found then return null; end if;
 return public.prepare_order_refund(p_actor,p_order,null,p_request,op.restock,p_live,op.request_items);
end $$;

create function public.resolve_order_refund(
 p_actor uuid,p_order uuid,p_request uuid,p_live boolean,p_provider text,p_status text
) returns boolean language plpgsql security definer set search_path='' as $$
declare
 o public.orders; op private.order_refunds; item record; full_refund boolean;
 ranges jsonb; earned integer;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found or o.live_payment is distinct from p_live then
  raise exception using errcode='22023',message='PAYMENT_MODE_MISMATCH';
 end if;
 select * into op from private.order_refunds where id=p_request and order_id=p_order for update;
 if not found or p_status is null or (
   op.cash_cents=0 and (p_status<>'no_cash' or p_provider is not null) or
   op.cash_cents>0 and (p_status not in ('succeeded','failed','canceled') or coalesce(p_provider,'') !~ '^re_[A-Za-z0-9_]+$')
 ) then raise exception using errcode='22023',message='INVALID_REFUND_RESULT'; end if;
 if op.status<>'pending' then
  if (op.provider_id,op.provider_status) is distinct from (p_provider,p_status) then
   raise exception using errcode='PT409',message='REFUND_RESULT_CHANGED';
  end if;
  return true;
 end if;

 if p_status in ('failed','canceled') then
  update private.order_refunds set status='aborted',provider_id=p_provider,provider_status=p_status,resolved_by=p_actor,resolved_at=now() where id=p_request;
  if op.legacy then
   update public.order_operations set status='aborted',provider_id=p_provider,completed_at=now() where order_id=p_order and action='refund';
  end if;
  return true;
 end if;

 if o.payment_status<>'paid' then raise exception using errcode='40001',message='ORDER_CHANGED'; end if;
 if op.restock then
  for item in select p.id,p.stock,p.sku,a.quantity
   from jsonb_to_recordset(op.item_allocations) as a(sku text,quantity integer)
   join public.products p on p.sku=a.sku order by p.sku for update of p
  loop
   update public.products set stock=stock+item.quantity,version=version+1 where id=item.id;
   insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key,actor_id)
   values(item.id,item.stock,item.quantity,item.stock+item.quantity,case when p_live then 'stripe_refund' else 'test_refund' end,
    'refund:'||(case when op.legacy then p_order else p_request end)||':'||item.sku,op.actor_id);
  end loop;
 end if;
 update public.order_items i set refunded_quantity=i.refunded_quantity+a.quantity
 from jsonb_to_recordset(op.item_allocations) as a(sku text,quantity integer)
 where i.order_id=p_order and i.sku=a.sku;

 -- Automatic closure requires both a fully repaid payment and every unit returned.
 full_refund:=op.request_items is null or (
  o.refunded_cents+op.cash_cents=o.total_cents and not exists(
   select 1 from public.order_items where order_id=p_order and refunded_quantity<quantity
  )
 );

 select coalesce(sum(a.earned),0),coalesce(jsonb_agg(jsonb_build_object('offset',a."offset",'points',a.points)
  order by a."offset") filter (where a.points>0),'[]'::jsonb)
 into earned,ranges from jsonb_to_recordset(op.item_allocations) as a(earned integer,"offset" integer,points integer);
 perform private.apply_membership_points_refund(p_order,p_request,earned,ranges);
 update private.order_refunds set status='completed',provider_id=p_provider,provider_status=p_status,resolved_by=p_actor,resolved_at=now() where id=p_request;
 if op.legacy then
  update public.order_operations set status='completed',provider_id=p_provider,completed_at=now() where order_id=p_order and action='refund';
 end if;
 update public.orders set refunded_cents=refunded_cents+op.cash_cents,
  refunded_merchandise_cents=refunded_merchandise_cents+op.merchandise_cents,
  payment_status=case when full_refund then 'refunded'::public.order_payment_status else payment_status end,
  fulfilment_status=case when full_refund then 'Cancelled'::public.order_fulfilment_status else fulfilment_status end,
  updated_at=now(),version=version+1 where id=p_order;
 if full_refund then
  perform public.queue_test_order_notice(p_order,'test_refund','refund/'||p_order);
  perform public.queue_test_order_notice(p_order,'cancellation','refund-cancellation/'||p_order);
 end if;
 return true;
end $$;

create or replace function public.guard_order_operation() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.fulfilment_status,new.payment_status,new.tracking_number) is distinct from
    (old.fulfilment_status,old.payment_status,old.tracking_number) and (
     exists(select 1 from public.order_operations where order_id=old.id and status='pending' and action='refund') or
     exists(select 1 from private.order_refunds where order_id=old.id and status='pending')
    ) then raise exception using errcode='40001',message='ORDER_OPERATION_PENDING'; end if;
 return new;
end $$;

create or replace function public.read_admin_orders(p_actor uuid)
returns jsonb language plpgsql security definer set search_path='' stable as $$
declare result jsonb;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) into result from (
  select o.id,'CVM-'||o.order_number as number,u.email,coalesce(p.display_name,'') as customer_name,
   a.full_name,a.address_line,a.postal_code,o.payment_status,o.fulfilment_status,o.tracking_number,
   o.subtotal_cents,o.shipping_cents,o.discount_cents,o.total_cents,o.created_at,o.paid_at,o.version,o.live_payment,
   o.refunded_cents,o.refunded_merchandise_cents,
   case when f.id is not null then jsonb_build_object('requestId',f.id,'items',f.request_items,'restock',f.restock,'amount',f.cash_cents)
    when l.order_id is not null then jsonb_build_object('requestId',null,'items',null,'restock',l.restock,'amount',o.total_cents)
   end as pending_refund,
   coalesce((select jsonb_agg(to_jsonb(i)-'order_id' order by i.sku) from public.order_items i where i.order_id=o.id),'[]'::jsonb) items
  from public.orders o join auth.users u on u.id=o.user_id left join public.buyer_profiles p on p.user_id=o.user_id
  left join private.order_delivery_addresses a on a.order_id=o.id
  left join private.order_refunds f on f.order_id=o.id and f.status='pending'
  left join public.order_operations l on l.order_id=o.id and l.status='pending' and l.action='refund'
 ) x;
 return result;
end $$;

-- Keep cancellations and transitional callers on the existing service RPCs.
create or replace function public.prepare_test_order_operation(p_actor uuid,p_order uuid,p_version integer,p_action text,p_restock boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; op public.order_operations;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 if not found then raise exception using errcode='22023',message='INVALID_ORDER'; end if;
 select * into op from public.order_operations where order_id=p_order and action=p_action;
 if found then
  if op.restock is distinct from p_restock or op.status='aborted' and p_action='refund' then
   raise exception using errcode='22023',message='OPERATION_CHANGED';
  end if;
 else
  if o.version<>p_version then raise exception using errcode='40001'; end if;
  if p_action='cancel' and (o.payment_status<>'pending' or o.fulfilment_status<>'Processing') or
     p_action='refund' and (o.payment_status<>'paid' or o.stripe_payment_intent_id is null or
       exists(select 1 from private.order_refunds where order_id=p_order)) or
     p_action not in ('cancel','refund') or p_action is null or p_restock is null then
    raise exception using errcode='22023',message='INVALID_OPERATION';
  end if;
  insert into public.order_operations(order_id,actor_id,action,restock) values(p_order,p_actor,p_action,p_restock) returning * into op;
 end if;
 return jsonb_build_object('completed',op.status='completed','session',o.stripe_checkout_session_id,
   'intent',o.stripe_payment_intent_id,'amount',o.total_cents,'currency',o.currency);
end $$;

create or replace function public.finish_test_order_operation(p_actor uuid,p_order uuid,p_action text,p_provider text)
returns boolean language plpgsql security definer set search_path='' as $$
declare o public.orders; op public.order_operations; refund jsonb;
begin
 if not exists(select 1 from public.admin_roles where user_id=p_actor) then raise exception using errcode='42501'; end if;
 select * into o from public.orders where id=p_order for update;
 select * into op from public.order_operations where order_id=p_order and action=p_action for update;
 if not found or nullif(p_provider,'') is null then raise exception using errcode='22023'; end if;
 if op.status='completed' then return true; end if;
 if op.action='refund' then
  refund:=public.prepare_order_refund(p_actor,p_order,o.version,null,op.restock,o.live_payment,null);
  return public.resolve_order_refund(p_actor,p_order,(refund->>'id')::uuid,o.live_payment,p_provider,'succeeded');
 end if;
 if p_provider='checkout_completed' then
  update public.order_operations set status='aborted',completed_at=now() where order_id=p_order and action=p_action;
  return false;
 end if;
 if o.payment_status='pending' then
  perform public.release_test_order(p_order);
  perform public.queue_test_order_notice(p_order,'cancellation','cancel/'||p_order);
 elsif o.payment_status<>'failed' or o.fulfilment_status<>'Cancelled' or
       o.stripe_checkout_session_id is distinct from p_provider then
  raise exception using errcode='40001';
 end if;
 update public.order_operations set status='completed',provider_id=p_provider,completed_at=now() where order_id=p_order and action=p_action;
 return true;
end $$;

revoke all on function private.legacy_refund_reduction(integer,bigint,integer),
 private.order_refund_allocations(public.orders,jsonb),
 public.prepare_order_refund(uuid,uuid,integer,uuid,boolean,boolean,jsonb),
 public.resume_order_refund(uuid,uuid,uuid,boolean),
 public.resolve_order_refund(uuid,uuid,uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.prepare_order_refund(uuid,uuid,integer,uuid,boolean,boolean,jsonb),
 public.resume_order_refund(uuid,uuid,uuid,boolean),
 public.resolve_order_refund(uuid,uuid,uuid,boolean,text,text) to service_role;

commit;
