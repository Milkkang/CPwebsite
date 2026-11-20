-- Minimal Supabase-owned auth objects required by the repository migrations.
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key default gen_random_uuid(), email text,
 email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
create table auth.sessions(id uuid primary key default gen_random_uuid(),
 user_id uuid references auth.users(id), not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
