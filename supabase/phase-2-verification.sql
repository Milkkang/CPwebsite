-- Re-runnable acceptance test. All fixtures/changes roll back, including failures.
begin;
do $$
begin
  assert (select count(*) from public.products)=678, 'listing count';
  assert (select count(distinct sku) from public.products)=678, 'unique SKU count';
  assert (select sum(stock) from public.products)=67800, 'initial stock';
  assert (select count(*) from public.inventory_movements)=678, 'initial ledger count';
  assert (select count(*) from public.products where currency<>'SGD' or price_cents<=0 or min_quantity<>3 or stock<>100)=0, 'data constraints';
  assert (select count(*) from public.categories)=11, 'category count';
  assert (select count(*) from public.coupons)=2, 'coupon count';
  assert (select count(*) from public.admin_roles)=0, 'no client-derived admin';
  assert (select shipping_cents=390 and free_threshold_cents=5000 from public.delivery_rules where id='singapore'), 'delivery rules';
  begin
    update public.products set price_cents=-1 where id='13M-01-01';
    raise exception 'negative price was accepted';
  exception when check_violation then null; end;
  begin
    update public.products set stock=-1 where id='13M-01-01';
    raise exception 'negative stock was accepted';
  exception when check_violation then null; end;
  begin
    update public.products set min_quantity=0 where id='13M-01-01';
    raise exception 'zero MOQ was accepted';
  exception when check_violation then null; end;
  begin
    update public.products set reserved_quantity=101 where id='13M-01-01';
    raise exception 'excess reservation was accepted';
  exception when check_violation then null; end;
  update public.products set name=name where id='13M-01-01';
  assert (select version from public.products where id='13M-01-01')=2, 'version increment';
end $$;
insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,status)
select 'PHASE2-DRAFT','PHASE2-DRAFT','Private draft','draft','test',category_id,image_url,original_image_url,r2_image_url,100,'Draft' from public.products where id='13M-01-01';
update public.homepage_config set published=false;
update public.delivery_rules set active=false;
set local role anon;
do $$
declare a jsonb; b jsonb; c jsonb;
begin
  assert (select count(*) from public.products)=678, 'anon cannot see draft';
  assert (select count(*) from public.products where id='PHASE2-DRAFT')=0, 'draft direct read';
  assert (select count(*) from public.homepage_config)=0, 'private homepage';
  assert (select count(*) from public.delivery_rules)=0, 'inactive delivery';
  a:=public.read_catalog();
  assert (a->'pagination'->>'total')::integer=678, 'RPC exact count';
  assert jsonb_array_length(a->'products')=30, 'default page size';
  b:=public.read_catalog(p_size=>50,p_page=>2);
  assert jsonb_array_length(b->'products')=50, '50 per page';
  c:=public.read_catalog(p_size=>100,p_page=>999999);
  assert (c->'pagination'->>'page')::integer=7, 'last page clamp';
  assert jsonb_array_length(c->'products')=78, 'last page items';
  a:=public.read_catalog(p_category=>'personal-care');
  assert (a->'pagination'->>'total')::integer=298, 'category filter';
  a:=public.read_catalog(p_query=>'13M-01-01');
  assert (a->'pagination'->>'total')::integer=1, 'SKU search';
  a:=public.read_catalog(p_query=>'PHASE2-DRAFT');
  assert (a->'pagination'->>'total')::integer=0, 'RPC draft exclusion';
  a:=public.read_catalog(p_query=>'%%%%');
  assert (a->'pagination'->>'total')::integer=0, 'literal search, no wildcard injection';
  begin
    perform public.read_catalog(p_size=>1000);
    raise exception 'unbounded RPC accepted';
  exception when invalid_parameter_value then null; end;
  begin
    update public.products set price_cents=1 where id='13M-01-01';
    raise exception 'anonymous write accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.admin_roles;
    raise exception 'anonymous roles read accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.inventory_movements;
    raise exception 'anonymous ledger read accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.coupons;
    raise exception 'anonymous coupon enumeration accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$
begin
  assert (select count(*) from public.products where id='PHASE2-DRAFT')=0, 'member cannot see drafts';
  begin
    insert into public.admin_roles(user_id) values (gen_random_uuid());
    raise exception 'self-granted admin accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.products set stock=100000 where id='13M-01-01';
    raise exception 'member stock mutation accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
select 'PASS: counts, money/MOQ/stock constraints, versioning, anon/member RLS, private tables, pagination, filtering, literal search; fixtures rolled back' as result;
