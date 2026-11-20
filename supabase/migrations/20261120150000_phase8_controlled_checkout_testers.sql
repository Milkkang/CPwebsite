-- Explicit, service-managed buyer test access. No public client may grant itself access.
create table public.checkout_testers(
 user_id uuid primary key references auth.users(id), enabled boolean not null default true,
 created_at timestamptz not null default now()
);
alter table public.checkout_testers enable row level security;
revoke all on public.checkout_testers from public,anon,authenticated;
grant all on public.checkout_testers to service_role;
create function public.is_checkout_tester(p_user uuid) returns boolean language sql stable security invoker set search_path='' as $$
 select exists(select 1 from public.checkout_testers where user_id=p_user and enabled)
$$;
revoke all on function public.is_checkout_tester(uuid) from public,anon,authenticated;
grant execute on function public.is_checkout_tester(uuid) to service_role;
