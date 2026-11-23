begin;

create function public.admin_bulk_ship_orders(p_actor uuid, p_orders jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare
 shipment record;
 current_order jsonb;
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

 -- The existing transition checks the version under a row lock. Use a stable lock order across batches.
 for shipment in
  select * from jsonb_to_recordset(p_orders) as item(id uuid, version integer, tracking text)
  order by id
 loop
  current_order:=public.read_order_json(shipment.id);
  if (current_order->>'version')::integer is distinct from shipment.version
   or current_order->>'payment_status' is distinct from 'paid'
   or current_order->>'fulfilment_status' is distinct from 'Processing' then
   raise exception using errcode='40001', message='ORDER_CHANGED';
  end if;
  perform public.admin_update_order(p_actor,shipment.id,shipment.version,'Shipped',shipment.tracking);
 end loop;
 return jsonb_array_length(p_orders);
end $$;

revoke all on function public.admin_bulk_ship_orders(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_bulk_ship_orders(uuid,jsonb) to service_role;

commit;
