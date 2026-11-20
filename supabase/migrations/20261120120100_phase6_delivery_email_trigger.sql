-- Enqueue one test delivery notice on the first audited Shipped -> Delivered transition.
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
 if previous='Shipped' and p_status='Delivered' then perform public.enqueue_order_email(o.id,'delivery','order/'||o.id||'/version/'||o.version); end if;
 return public.read_order_json(o.id,null);
end $$;
