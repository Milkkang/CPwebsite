-- Facets use the same published catalog and literal query matching as read_catalog.
create function public.read_catalog_brands(p_query text default '',p_category text default '')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_query is null or length(p_query)>120 or p_category is null or length(p_category)>80 then
    raise exception using errcode='22023',message='Invalid catalog parameters';
  end if;
  select coalesce(jsonb_agg(brand order by brand),'[]'::jsonb) into result from (
    select distinct p.brand from public.products p where p.status='Published'
      and (p_category='' or p.category_id=p_category)
      and (p_query='' or strpos(p.search_text,lower(p_query))>0)
  ) facets;
  return result;
end $$;
revoke all on function public.read_catalog_brands(text,text) from public;
grant execute on function public.read_catalog_brands(text,text) to anon,authenticated,service_role;
