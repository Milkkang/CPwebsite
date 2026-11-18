-- Synthetic identities only; no Auth HTTP calls or emails. Entire test rolls back.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('33333333-3333-4333-8333-333333333331','phase3-a@example.invalid',now(),'{"role":"admin","is_admin":true}'),
 ('33333333-3333-4333-8333-333333333332','phase3-b@example.invalid',now(),'{}');
insert into auth.sessions(id,user_id) values
 ('44444444-4444-4444-8444-444444444441','33333333-3333-4333-8333-333333333331'),
 ('44444444-4444-4444-8444-444444444442','33333333-3333-4333-8333-333333333332');
insert into public.buyer_profiles(user_id,display_name) values
 ('33333333-3333-4333-8333-333333333331','Test A'),('33333333-3333-4333-8333-333333333332','Test B');
insert into public.buyer_addresses(user_id,full_name,address_line,postal_code) values
 ('33333333-3333-4333-8333-333333333331','Test A','Test address A','000001'),
 ('33333333-3333-4333-8333-333333333332','Test B','Test address B','000002');
insert into public.server_sessions(session_hash,user_id,auth_session_id,access_token_encrypted,expires_at) values
 (repeat('a',64),'33333333-3333-4333-8333-333333333331','44444444-4444-4444-8444-444444444441','test-fixture-only',now()+interval '1 hour'),
 (repeat('b',64),'33333333-3333-4333-8333-333333333332','44444444-4444-4444-8444-444444444442','test-fixture-only',now()+interval '1 hour');
set local role authenticated;
set local request.jwt.claims='{"sub":"33333333-3333-4333-8333-333333333331","role":"authenticated","session_id":"44444444-4444-4444-8444-444444444441"}';
do $$begin
 assert (select count(*) from public.buyer_profiles)=1,'profile isolation';
 assert (select display_name from public.buyer_profiles)='Test A','own profile';
 assert (select count(*) from public.buyer_addresses)=1,'address isolation';
 update public.buyer_profiles set display_name='Updated A' where user_id='33333333-3333-4333-8333-333333333331';
 begin
  update public.buyer_profiles set user_id='33333333-3333-4333-8333-333333333332' where user_id='33333333-3333-4333-8333-333333333331';
  raise exception 'ownership transfer accepted';
 exception when insufficient_privilege then null;end;
 begin perform public.resolve_web_session(repeat('a',64));raise exception 'member could call service identity lookup';exception when insufficient_privilege then null;end;
 begin perform 1 from public.server_sessions;raise exception 'member can read session tokens';exception when insufficient_privilege then null;end;
 begin insert into public.admin_roles(user_id) values('33333333-3333-4333-8333-333333333331');raise exception 'self admin grant accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
set local role service_role;
set local request.jwt.claims='{"role":"service_role"}';
do $$declare who jsonb;begin
 who:=public.resolve_web_session(repeat('a',64));
 assert who->'account'->>'name'='Updated A','service lookup sees profile';
 assert (who->>'isAdmin')::boolean=false,'metadata cannot grant admin';
 assert public.consume_auth_limit(repeat('c',64),1,60)=true,'initial request';
 assert public.consume_auth_limit(repeat('c',64),1,60)=false,'rate limit enforced';
end $$;
reset role;
delete from auth.sessions where id='44444444-4444-4444-8444-444444444441';
set local role authenticated;
set local request.jwt.claims='{"sub":"33333333-3333-4333-8333-333333333331","role":"authenticated","session_id":"44444444-4444-4444-8444-444444444441"}';
do $$begin assert (select count(*) from public.buyer_profiles)=0,'revoked session cannot read with old JWT';assert (select count(*) from public.buyer_addresses)=0,'revoked address read';end $$;
reset role;
set local role anon;
do $$begin
 begin perform 1 from public.buyer_profiles;raise exception 'anonymous profile read';exception when insufficient_privilege then null;end;
 begin perform public.resolve_web_session(repeat('b',64));raise exception 'anonymous session lookup';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
select 'PASS: two-user profile/address isolation; ownership checks; metadata/admin denial; session secrecy/revocation; rate limiting; all fixtures rolled back' as result;
