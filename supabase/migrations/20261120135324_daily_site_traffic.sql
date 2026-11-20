-- First-party, day-level traffic counts. No IP address, route, or visitor ID is stored here.
create table public.daily_site_traffic (
 day date primary key,
 visit_sessions bigint not null default 0 check (visit_sessions >= 0),
 cart_sessions bigint not null default 0 check (cart_sessions >= 0)
);
alter table public.daily_site_traffic enable row level security;
revoke all on public.daily_site_traffic from public, anon, authenticated;
grant select, insert, update on public.daily_site_traffic to service_role;

create function public.record_site_traffic(p_event text) returns void
 language plpgsql security invoker set search_path = public, pg_temp as $$
begin
 if p_event not in ('visit', 'cart') then
  raise exception 'Invalid traffic event' using errcode = '22023';
 end if;
 insert into public.daily_site_traffic(day, visit_sessions, cart_sessions)
 values ((now() at time zone 'Asia/Singapore')::date,
         case when p_event = 'visit' then 1 else 0 end,
         case when p_event = 'cart' then 1 else 0 end)
 on conflict (day) do update set
  visit_sessions = daily_site_traffic.visit_sessions + excluded.visit_sessions,
  cart_sessions = daily_site_traffic.cart_sessions + excluded.cart_sessions;
end;
$$;
revoke all on function public.record_site_traffic(text) from public, anon, authenticated;
grant execute on function public.record_site_traffic(text) to service_role;
