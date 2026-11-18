create schema if not exists private;
revoke all on schema private from public,anon;
grant usage on schema private to authenticated,service_role;
create table public.buyer_profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 display_name text not null default '' check(length(display_name)<=80),
 version bigint not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.buyer_addresses (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
 full_name text not null check(length(full_name) between 1 and 80),
 address_line text not null check(length(address_line) between 1 and 200),
 postal_code text not null check(postal_code ~ '^[0-9]{6}$'),
 country_code text not null default 'SG' check(country_code='SG'),
 version bigint not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index buyer_addresses_user_idx on public.buyer_addresses(user_id);
create table public.server_sessions (
 session_hash text primary key check(session_hash ~ '^[a-f0-9]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 auth_session_id uuid not null references auth.sessions(id) on delete cascade,
 access_token_encrypted text not null, recovery_only boolean not null default false,
 expires_at timestamptz not null,created_at timestamptz not null default now()
);
create index server_sessions_user_idx on public.server_sessions(user_id);
create index server_sessions_auth_idx on public.server_sessions(auth_session_id);
create index server_sessions_expiry_idx on public.server_sessions(expires_at);
create table public.auth_rate_limits (
 bucket_key text primary key, attempts integer not null check(attempts>0), expires_at timestamptz not null
);
create index auth_rate_limits_expiry_idx on public.auth_rate_limits(expires_at);
revoke all on public.buyer_profiles,public.buyer_addresses,public.server_sessions,public.auth_rate_limits from public,anon,authenticated;
grant select,insert,update on public.buyer_profiles to authenticated;
grant select,insert,update,delete on public.buyer_addresses to authenticated;
grant all on public.buyer_profiles,public.buyer_addresses,public.server_sessions,public.auth_rate_limits to service_role;
alter table public.buyer_profiles enable row level security;
alter table public.buyer_addresses enable row level security;
alter table public.server_sessions enable row level security;
alter table public.auth_rate_limits enable row level security;
-- Narrow privileged helper: only the current JWT's user/session can be checked.
create function private.current_session_active() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists (
   select 1 from auth.sessions s join auth.users u on u.id=s.user_id
   where s.id::text=auth.jwt()->>'session_id' and s.user_id=auth.uid()
     and (s.not_after is null or s.not_after>now()) and u.email_confirmed_at is not null
     and (u.banned_until is null or u.banned_until<now()) and u.deleted_at is null
 );
$$;
revoke all on function private.current_session_active() from public,anon;
grant execute on function private.current_session_active() to authenticated;
create policy profile_owner_read on public.buyer_profiles for select to authenticated using(user_id=(select auth.uid()) and (select private.current_session_active()));
create policy profile_owner_insert on public.buyer_profiles for insert to authenticated with check(user_id=(select auth.uid()) and (select private.current_session_active()));
create policy profile_owner_update on public.buyer_profiles for update to authenticated using(user_id=(select auth.uid()) and (select private.current_session_active())) with check(user_id=(select auth.uid()) and (select private.current_session_active()));
create policy address_owner on public.buyer_addresses for all to authenticated using(user_id=(select auth.uid()) and (select private.current_session_active())) with check(user_id=(select auth.uid()) and (select private.current_session_active()));
create trigger profiles_version before update on public.buyer_profiles for each row execute function public.bump_row_version();
create trigger addresses_version before update on public.buyer_addresses for each row execute function public.bump_row_version();
-- Service-only lookup. No client JWT, email field or metadata can grant an administrator role.
create function private.resolve_web_session(p_hash text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('account',jsonb_build_object('id',u.id,'email',u.email,'name',coalesce(p.display_name,''),'verified',true),
   'isAdmin',not w.recovery_only and lower(u.email)='milkkang93@gmail.com' and exists(select 1 from public.admin_roles a where a.user_id=u.id),
   'recoveryOnly',w.recovery_only,'expiresAt',w.expires_at)
 from public.server_sessions w join auth.users u on u.id=w.user_id
 join auth.sessions s on s.id=w.auth_session_id and s.user_id=u.id
 left join public.buyer_profiles p on p.user_id=u.id
 where auth.jwt()->>'role'='service_role' and w.session_hash=p_hash and w.expires_at>now()
   and (s.not_after is null or s.not_after>now()) and u.email_confirmed_at is not null
   and (u.banned_until is null or u.banned_until<now()) and u.deleted_at is null;
$$;
revoke all on function private.resolve_web_session(text) from public,anon,authenticated;
grant execute on function private.resolve_web_session(text) to service_role;
create function public.resolve_web_session(p_hash text) returns jsonb language sql stable security invoker set search_path='' as $$ select private.resolve_web_session(p_hash); $$;
revoke all on function public.resolve_web_session(text) from public,anon,authenticated;
grant execute on function public.resolve_web_session(text) to service_role;
create function public.consume_auth_limit(p_key text,p_limit integer,p_seconds integer) returns boolean language plpgsql security invoker set search_path='' as $$
declare count_now integer;
begin
 if length(p_key)<>64 or p_limit<1 or p_limit>100 or p_seconds<1 or p_seconds>3600 then raise exception 'Invalid rate limit'; end if;
 delete from public.auth_rate_limits where expires_at<now();
 insert into public.auth_rate_limits(bucket_key,attempts,expires_at) values(p_key,1,now()+make_interval(secs=>p_seconds))
 on conflict(bucket_key) do update set attempts=public.auth_rate_limits.attempts+1
 returning attempts into count_now;
 return count_now<=p_limit;
end $$;
revoke all on function public.consume_auth_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.consume_auth_limit(text,integer,integer) to service_role;
