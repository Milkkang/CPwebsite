-- Honor explicitly authorized QA admin roles without changing the owner-only default.
-- Removing either QA tester access or its admin role immediately removes QA admin access.
create or replace function private.resolve_web_session(p_hash text) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('account',jsonb_build_object('id',u.id,'email',u.email,'name',coalesce(p.display_name,''),'verified',true),
   'isAdmin',not w.recovery_only and (lower(u.email)='milkkang93@gmail.com' or exists(select 1 from public.checkout_testers t where t.user_id=u.id and t.enabled)) and exists(select 1 from public.admin_roles a where a.user_id=u.id),
   'recoveryOnly',w.recovery_only,'expiresAt',w.expires_at)
 from public.server_sessions w join auth.users u on u.id=w.user_id
 join auth.sessions s on s.id=w.auth_session_id and s.user_id=u.id
 left join public.buyer_profiles p on p.user_id=u.id
 where auth.jwt()->>'role'='service_role' and w.session_hash=p_hash and w.expires_at>now()
   and (s.not_after is null or s.not_after>now()) and u.email_confirmed_at is not null
   and (u.banned_until is null or u.banned_until<now()) and u.deleted_at is null;
$$;
