-- Phase 4 member shopping state. The Worker supplies the user ID from its
-- verified HttpOnly session; browser clients have no direct table privileges.
create table public.buyer_cart_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  sku text not null references public.products(id),
  quantity integer not null check (quantity between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id,sku)
);
create table public.buyer_saved_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  sku text not null references public.products(id),
  created_at timestamptz not null default now(),
  primary key (user_id,sku)
);
create table public.buyer_recent_products (
  user_id uuid not null references auth.users(id) on delete cascade,
  sku text not null references public.products(id),
  viewed_at timestamptz not null default now(),
  primary key (user_id,sku)
);
create index buyer_recent_products_order_idx on public.buyer_recent_products(user_id,viewed_at desc);
revoke all on public.buyer_cart_items,public.buyer_saved_items,public.buyer_recent_products from public,anon,authenticated;
grant select,insert,update,delete on public.buyer_cart_items,public.buyer_saved_items,public.buyer_recent_products to service_role;
alter table public.buyer_cart_items enable row level security;
alter table public.buyer_saved_items enable row level security;
alter table public.buyer_recent_products enable row level security;

create function public.set_member_cart(p_user uuid,p_sku text,p_quantity integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.products%rowtype;
begin
  if p_user is null or p_sku is null or length(p_sku)>100 or p_quantity is null or p_quantity<0 or p_quantity>100000 then
    raise exception using errcode='22023',message='Invalid cart item';
  end if;
  if p_quantity=0 then
    delete from public.buyer_cart_items where user_id=p_user and sku=p_sku;
    return jsonb_build_object('sku',p_sku,'quantity',0);
  end if;
  select * into item from public.products where id=p_sku for share;
  if not found or item.status<>'Published' then
    raise exception using errcode='22023',message='Product unavailable';
  end if;
  if p_quantity<item.min_quantity or p_quantity>item.available_quantity then
    raise exception using errcode='22023',message='Quantity unavailable';
  end if;
  insert into public.buyer_cart_items(user_id,sku,quantity) values(p_user,p_sku,p_quantity)
  on conflict (user_id,sku) do update set quantity=excluded.quantity,updated_at=now();
  return jsonb_build_object('sku',p_sku,'quantity',p_quantity);
end $$;
revoke all on function public.set_member_cart(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.set_member_cart(uuid,text,integer) to service_role;

create function public.merge_member_cart(p_user uuid,p_items jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare entry jsonb; item public.products%rowtype; current_qty integer; requested integer; merged jsonb:='[]'::jsonb; skipped jsonb:='[]'::jsonb; sku_value text;
begin
  if p_user is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>100 then
    raise exception using errcode='22023',message='Invalid cart merge';
  end if;
  for entry in select value from jsonb_array_elements(p_items) as x(value) loop
    sku_value:=entry->>'sku';
    if sku_value is null or length(sku_value)>100 or (entry->>'quantity') !~ '^[1-9][0-9]{0,5}$' then
      raise exception using errcode='22023',message='Invalid cart merge';
    end if;
    requested:=(entry->>'quantity')::integer;
    select * into item from public.products where id=sku_value for share;
    if not found or item.status<>'Published' then
      skipped:=skipped||jsonb_build_object('sku',sku_value,'reason','unavailable');
      continue;
    end if;
    select quantity into current_qty from public.buyer_cart_items where user_id=p_user and sku=sku_value for update;
    requested:=coalesce(current_qty,0)+requested;
    if requested<item.min_quantity or requested>item.available_quantity then
      skipped:=skipped||jsonb_build_object('sku',sku_value,'reason','quantity');
      continue;
    end if;
    insert into public.buyer_cart_items(user_id,sku,quantity) values(p_user,sku_value,requested)
    on conflict (user_id,sku) do update set quantity=excluded.quantity,updated_at=now();
    merged:=merged||jsonb_build_object('sku',sku_value,'quantity',requested);
  end loop;
  return jsonb_build_object('merged',merged,'skipped',skipped);
end $$;
revoke all on function public.merge_member_cart(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.merge_member_cart(uuid,jsonb) to service_role;

create function public.read_member_shopping(p_user uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'cart',coalesce((select jsonb_agg(jsonb_build_object('sku',c.sku,'quantity',c.quantity,'product',to_jsonb(p)-'search_text') order by c.created_at)
      from public.buyer_cart_items c join public.products p on p.id=c.sku where c.user_id=p_user),'[]'::jsonb),
    'saved',coalesce((select jsonb_agg(s.sku order by s.created_at desc) from public.buyer_saved_items s where s.user_id=p_user),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(r.sku order by r.viewed_at desc) from
      (select sku,viewed_at from public.buyer_recent_products where user_id=p_user order by viewed_at desc limit 12) r),'[]'::jsonb),
    'savedProducts',coalesce((select jsonb_agg(to_jsonb(p)-'search_text') from public.buyer_saved_items s
      join public.products p on p.id=s.sku where s.user_id=p_user),'[]'::jsonb),
    'recentProducts',coalesce((select jsonb_agg(to_jsonb(p)-'search_text') from
      (select sku from public.buyer_recent_products where user_id=p_user order by viewed_at desc limit 12) r
      join public.products p on p.id=r.sku),'[]'::jsonb)
  )
$$;
revoke all on function public.read_member_shopping(uuid) from public,anon,authenticated;
grant execute on function public.read_member_shopping(uuid) to service_role;
