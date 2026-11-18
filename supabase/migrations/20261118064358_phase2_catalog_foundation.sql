-- Additive migration for the previously empty production database.
-- No member, order, payment or browser-preview transaction data is imported.
create table public.categories (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null check (length(name) between 1 and 120),
  icon text not null default '', color text not null default 'sage',
  sort_order integer not null default 0, published boolean not null default true,
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.products (
  id text primary key check (length(id) between 1 and 100),
  sku text not null unique check (sku = id),
  name text not null check (length(name) between 1 and 500),
  variant_name text not null, brand text not null,
  category_id text not null references public.categories(id),
  description text not null default '', keywords text not null default '',
  status text not null default 'Draft' check (status in ('Published','Draft','Archived')),
  featured boolean not null default false,
  image_url text not null check (image_url ~ '^https://[^[:space:]]+$'),
  original_image_url text not null check (original_image_url ~ '^https://[^[:space:]]+$'),
  r2_image_url text not null check (r2_image_url ~ '^https://[^[:space:]]+$'),
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'SGD' check (currency = 'SGD'),
  stock integer not null default 0 check (stock >= 0),
  reserved_quantity integer not null default 0 check (reserved_quantity between 0 and stock),
  available_quantity integer generated always as (stock - reserved_quantity) stored,
  min_quantity integer not null default 1 check (min_quantity > 0),
  sort_order integer not null default 0,
  search_text text generated always as (lower(name || ' ' || brand || ' ' || sku || ' ' || keywords)) stored,
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index products_category_listing_idx on public.products(category_id,sort_order,id) where status='Published';
create index products_brand_listing_idx on public.products(brand,sort_order,id) where status='Published';
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id text not null references public.products(id),
  quantity_before integer not null check (quantity_before >= 0),
  delta integer not null,
  quantity_after integer not null check (quantity_after >= 0 and quantity_after = quantity_before + delta),
  kind text not null, source_key text not null unique, actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index inventory_movements_product_idx on public.inventory_movements(product_id,created_at);
create index inventory_movements_actor_idx on public.inventory_movements(actor_id);
create table public.homepage_config (
  id text primary key check (id='home'), content jsonb not null check (jsonb_typeof(content)='object'),
  published boolean not null default true,
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.delivery_rules (
  id text primary key, country_code text not null check (country_code='SG'),
  shipping_cents integer not null check (shipping_cents >= 0),
  free_threshold_cents integer not null check (free_threshold_cents >= 0),
  active boolean not null default true,
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.coupons (
  code text primary key check (code ~ '^[A-Z0-9_-]{1,40}$'),
  kind text not null check (kind in ('percent','fixed','shipping')),
  amount integer not null check (amount >= 0 and (kind <> 'percent' or amount <= 100)),
  minimum_cents integer not null check (minimum_cents >= 0), active boolean not null default false,
  version bigint not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role='admin'),
  created_at timestamptz not null default now()
);
create table public.import_runs (
  id text primary key, dataset_hash text not null, expected_listings integer not null,
  created_at timestamptz not null default now()
);

-- Explicit privileges; no client can write any Phase 2 table.
revoke all on public.categories,public.products,public.inventory_movements,public.homepage_config,public.delivery_rules,public.coupons,public.admin_roles,public.import_runs from public,anon,authenticated;
grant select on public.categories,public.products,public.homepage_config,public.delivery_rules to anon,authenticated;
grant all on public.categories,public.products,public.inventory_movements,public.homepage_config,public.delivery_rules,public.coupons,public.admin_roles,public.import_runs to service_role;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.homepage_config enable row level security;
alter table public.delivery_rules enable row level security;
alter table public.coupons enable row level security;
alter table public.admin_roles enable row level security;
alter table public.import_runs enable row level security;
create policy categories_public_read on public.categories for select to anon,authenticated using (published);
create policy products_public_read on public.products for select to anon,authenticated using (status='Published');
create policy homepage_public_read on public.homepage_config for select to anon,authenticated using (published);
create policy delivery_public_read on public.delivery_rules for select to anon,authenticated using (active);

create function public.bump_row_version() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.bump_row_version() from public,anon,authenticated;
create trigger categories_version before update on public.categories for each row execute function public.bump_row_version();
create trigger products_version before update on public.products for each row execute function public.bump_row_version();
create trigger homepage_version before update on public.homepage_config for each row execute function public.bump_row_version();
create trigger delivery_version before update on public.delivery_rules for each row execute function public.bump_row_version();
create trigger coupons_version before update on public.coupons for each row execute function public.bump_row_version();

-- Read-only, security INVOKER: RLS applies even when called directly via PostgREST.
-- Count and rows share the same statement snapshot. Stable SKU tie-breaker avoids page overlap.
create function public.read_catalog(
  p_query text default '', p_category text default '', p_brand text default '',
  p_sort text default 'featured', p_size integer default 30, p_page integer default 1
) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
  if p_query is null or length(p_query)>120 or p_category is null or length(p_category)>80
    or p_brand is null or length(p_brand)>120 or p_size is null or p_size not in (30,50,100)
    or p_page is null or p_page<1 or p_page>1000000
    or p_sort is null or p_sort not in ('featured','price-up','price-down','name') then
    raise exception using errcode='22023',message='Invalid catalog parameters';
  end if;
  with filtered as materialized (
    select p.* from public.products p
    where p.status='Published'
      and (p_category='' or p.category_id=p_category)
      and (p_brand='' or p.brand=p_brand)
      and (p_query='' or strpos(p.search_text,lower(p_query))>0)
  ), totals as (select count(*)::integer as total from filtered),
  paging as (select total,greatest(1,(total+p_size-1)/p_size) as pages,
    least(p_page,greatest(1,(total+p_size-1)/p_size)) as page from totals),
  page_rows as (
    select to_jsonb(f)-'search_text' as item,
      row_number() over (order by
        case when p_sort='featured' then f.featured end desc,
        case when p_sort='featured' then f.sort_order end asc,
        case when p_sort='price-up' then f.price_cents end asc,
        case when p_sort='price-down' then f.price_cents end desc,
        case when p_sort='name' then f.name end asc, f.id asc) as position
    from filtered f order by position
    limit p_size offset (select (page-1)*p_size from paging)
  )
  select jsonb_build_object('products',coalesce((select jsonb_agg(item order by position) from page_rows),'[]'::jsonb),
    'pagination',jsonb_build_object('total',total,'totalPages',pages,'page',page,'pageSize',p_size),'currency','SGD') into result from paging;
  return result;
end $$;
revoke all on function public.read_catalog(text,text,text,text,integer,integer) from public;
grant execute on function public.read_catalog(text,text,text,text,integer,integer) to anon,authenticated,service_role;
