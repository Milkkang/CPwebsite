begin;

alter table public.buyer_profiles
 add column checkout_email text check (
  checkout_email is null or (
   char_length(checkout_email) between 3 and 254
   and checkout_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  )
 );

create or replace function private.resolve_web_session(p_hash text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('account',jsonb_build_object('id',u.id,'email',u.email,'name',coalesce(p.display_name,''),
   'checkoutEmail',p.checkout_email,'verified',true),
   'isAdmin',not w.recovery_only and (lower(u.email)='milkkang93@gmail.com' or exists(select 1 from public.checkout_testers t where t.user_id=u.id and t.enabled)) and exists(select 1 from public.admin_roles a where a.user_id=u.id),
   'recoveryOnly',w.recovery_only,'expiresAt',w.expires_at)
 from public.server_sessions w join auth.users u on u.id=w.user_id
 join auth.sessions s on s.id=w.auth_session_id and s.user_id=u.id
 left join public.buyer_profiles p on p.user_id=u.id
 where auth.jwt()->>'role'='service_role' and w.session_hash=p_hash and w.expires_at>now()
   and (s.not_after is null or s.not_after>now()) and u.email_confirmed_at is not null
   and (u.banned_until is null or u.banned_until<now()) and u.deleted_at is null;
$$;

create function public.admin_bulk_deliver_orders(p_actor uuid, p_orders jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare
 item record;
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
 if (select count(distinct id) from jsonb_to_recordset(p_orders) as entry(id uuid)) <> jsonb_array_length(p_orders) then
  raise exception using errcode='22023';
 end if;

 -- Keep row locking consistent across batches and reuse the transition that queues delivery mail.
 for item in
  select * from jsonb_to_recordset(p_orders) as entry(id uuid, version integer) order by id
 loop
  current_order:=public.read_order_json(item.id);
  if (current_order->>'version')::integer is distinct from item.version
   or current_order->>'payment_status' is distinct from 'paid'
   or current_order->>'fulfilment_status' is distinct from 'Shipped' then
   raise exception using errcode='40001', message='ORDER_CHANGED';
  end if;
  perform public.admin_update_order(p_actor,item.id,item.version,'Delivered',current_order->>'tracking_number');
 end loop;
 return jsonb_array_length(p_orders);
end $$;

revoke all on function public.admin_bulk_deliver_orders(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_bulk_deliver_orders(uuid,jsonb) to service_role;

commit;
