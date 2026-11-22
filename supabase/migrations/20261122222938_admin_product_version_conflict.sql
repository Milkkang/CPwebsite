-- Use an explicit PostgREST conflict status for a failed version precondition.
-- Replacing the function preserves its service-role-only grants.
create or replace function public.admin_write_product(
  p_actor uuid,p_sku text,p_expected_version bigint,p_fields jsonb default '{}'::jsonb,p_stock integer default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare item public.products%rowtype; result_row public.products%rowtype; old_stock integer; new_stock integer;
begin
  if p_actor is null or not exists(select 1 from public.admin_roles where user_id=p_actor) then
    raise exception using errcode='42501',message='Administrator required';
  end if;
  if p_sku is null or p_sku !~ '^[A-Za-z0-9_-]{1,100}$' or p_expected_version is null
    or p_fields is null or jsonb_typeof(p_fields)<>'object' or p_stock is not null and (p_stock<0 or p_stock>1000000) then
    raise exception using errcode='22023',message='Invalid product input';
  end if;
  select * into item from public.products where id=p_sku for update;
  if not found then
    if p_expected_version<>0 then raise exception using errcode='PT409',message='Product version changed'; end if;
    if p_stock is null then new_stock:=0; else new_stock:=p_stock; end if;
    insert into public.products(id,sku,name,variant_name,brand,category_id,description,keywords,status,featured,
      image_url,original_image_url,r2_image_url,price_cents,stock,min_quantity)
    values (p_sku,p_sku,p_fields->>'name',p_fields->>'variant_name',p_fields->>'brand',p_fields->>'category_id',
      coalesce(p_fields->>'description',''),coalesce(p_fields->>'keywords',''),coalesce(p_fields->>'status','Draft'),
      coalesce((p_fields->>'featured')::boolean,false),p_fields->>'image_url',
      coalesce(p_fields->>'original_image_url',p_fields->>'image_url'),
      coalesce(p_fields->>'r2_image_url',p_fields->>'image_url'),
      (p_fields->>'price_cents')::integer,new_stock,(p_fields->>'min_quantity')::integer)
    returning * into result_row;
    if new_stock<>0 then
      insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key,actor_id)
      values (p_sku,0,new_stock,new_stock,'admin_create','admin:'||gen_random_uuid()::text,p_actor);
    end if;
  else
    if item.version<>p_expected_version then raise exception using errcode='PT409',message='Product version changed'; end if;
    old_stock:=item.stock; new_stock:=coalesce(p_stock,item.stock);
    if new_stock<item.reserved_quantity then raise exception using errcode='22023',message='Stock below reserved quantity'; end if;
    update public.products set
      name=coalesce(p_fields->>'name',item.name),variant_name=coalesce(p_fields->>'variant_name',item.variant_name),
      brand=coalesce(p_fields->>'brand',item.brand),category_id=coalesce(p_fields->>'category_id',item.category_id),
      description=coalesce(p_fields->>'description',item.description),keywords=coalesce(p_fields->>'keywords',item.keywords),
      status=coalesce(p_fields->>'status',item.status),featured=coalesce((p_fields->>'featured')::boolean,item.featured),
      image_url=coalesce(p_fields->>'image_url',item.image_url),
      r2_image_url=coalesce(p_fields->>'r2_image_url',item.r2_image_url),
      price_cents=coalesce((p_fields->>'price_cents')::integer,item.price_cents),
      min_quantity=coalesce((p_fields->>'min_quantity')::integer,item.min_quantity),stock=new_stock
    where id=p_sku returning * into result_row;
    if new_stock<>old_stock then
      insert into public.inventory_movements(product_id,quantity_before,delta,quantity_after,kind,source_key,actor_id)
      values (p_sku,old_stock,new_stock-old_stock,new_stock,'admin_adjust','admin:'||gen_random_uuid()::text,p_actor);
    end if;
  end if;
  return to_jsonb(result_row)-'search_text';
end $$;
