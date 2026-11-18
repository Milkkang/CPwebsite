-- Additive: retain every saved address and select the earliest when no preference exists.
alter table public.buyer_profiles add column default_address_id uuid;
alter table public.buyer_addresses add constraint buyer_addresses_owner_id_key unique(user_id,id);
alter table public.buyer_profiles add constraint profiles_default_address_owner_fk
 foreign key(user_id,default_address_id) references public.buyer_addresses(user_id,id) on delete set null (default_address_id)
 deferrable initially deferred;
create index profiles_default_address_owner_idx on public.buyer_profiles(user_id,default_address_id);
insert into public.buyer_profiles(user_id) select distinct user_id from public.buyer_addresses on conflict do nothing;
update public.buyer_profiles p set default_address_id=(select a.id from public.buyer_addresses a where a.user_id=p.user_id order by a.created_at,a.id limit 1)
 where p.default_address_id is null and exists(select 1 from public.buyer_addresses a where a.user_id=p.user_id);

create function public.read_member_addresses(p_user_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$
 with rows as (
  select a.id,a.full_name,a.address_line,a.postal_code,a.country_code,a.version,a.created_at,
    a.id=coalesce(p.default_address_id,first_value(a.id) over(order by a.created_at,a.id)) as is_default
  from public.buyer_addresses a left join public.buyer_profiles p on p.user_id=a.user_id
  where a.user_id=p_user_id
 )
 select coalesce(jsonb_agg(to_jsonb(r)-'created_at' order by r.is_default desc,r.created_at,r.id),'[]'::jsonb) from rows r;
$$;
revoke all on function public.read_member_addresses(uuid) from public,anon,authenticated;
grant execute on function public.read_member_addresses(uuid) to service_role;

create function public.change_member_address(p_user_id uuid,p_action text,p_address_id uuid default null,p_fields jsonb default '{}'::jsonb)
 returns jsonb language plpgsql security invoker set search_path='' as $$
declare chosen uuid; address jsonb;
begin
 if p_action not in ('create','default','delete') or p_action is null or p_user_id is null then raise exception using errcode='22023',message='Invalid address action'; end if;
 -- Serialize all mutations for one buyer, including concurrent first inserts/default changes/deletes.
 insert into public.buyer_profiles(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.buyer_profiles where user_id=p_user_id for update;
 if p_action='create' then
  insert into public.buyer_addresses(user_id,full_name,address_line,postal_code,country_code)
  values(p_user_id,p_fields->>'full_name',p_fields->>'address_line',p_fields->>'postal_code','SG') returning id into chosen;
 elsif not exists(select 1 from public.buyer_addresses where id=p_address_id and user_id=p_user_id) then
  return null;
 elsif p_action='default' then
  update public.buyer_profiles set default_address_id=p_address_id where user_id=p_user_id;
 else
  update public.buyer_profiles set default_address_id=null where user_id=p_user_id and default_address_id=p_address_id;
  delete from public.buyer_addresses where id=p_address_id and user_id=p_user_id;
 end if;
 update public.buyer_profiles p set default_address_id=(select a.id from public.buyer_addresses a where a.user_id=p_user_id order by a.created_at,a.id limit 1)
 where p.user_id=p_user_id and p.default_address_id is null;
 if chosen is not null then
  select item into address from jsonb_array_elements(public.read_member_addresses(p_user_id)) item where item->>'id'=chosen::text;
  return address;
 end if;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.change_member_address(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.change_member_address(uuid,text,uuid,jsonb) to service_role;
