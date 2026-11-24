alter table public.products
  add column variant_of text references public.products(sku),
  add constraint products_variant_not_self check (variant_of is distinct from sku);

create index products_variant_of_idx on public.products(variant_of) where variant_of is not null;

create function public.admin_add_product_variant(
  p_actor uuid,p_parent_sku text,p_sku text,p_fields jsonb,p_stock integer
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare group_sku text; result_row public.products%rowtype;
begin
  if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then
    raise exception using errcode='42501',message='Administrator required';
  end if;

  select coalesce(variant_of,sku) into group_sku from public.products where sku=p_parent_sku for key share;
  if not found then
    raise exception using errcode='P0002',message='Product group not found';
  end if;

  perform public.admin_write_product(p_actor,p_sku,0,p_fields,p_stock);
  update public.products set variant_of=group_sku where sku=p_sku returning * into result_row;
  return to_jsonb(result_row)-'search_text';
end $$;

revoke all on function public.admin_add_product_variant(uuid,text,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.admin_add_product_variant(uuid,text,text,jsonb,integer) to service_role;
