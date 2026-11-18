begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('77777777-7777-4777-8777-777777777771','default-a@example.invalid',now()),
 ('77777777-7777-4777-8777-777777777772','default-b@example.invalid',now());
set local role service_role;
do $$declare a uuid; b uuid; other_id uuid; rows jsonb;begin
 a:=(public.change_member_address('77777777-7777-4777-8777-777777777771','create',null,'{"full_name":"A","address_line":"test A","postal_code":"000001"}')->>'id')::uuid;
 rows:=public.read_member_addresses('77777777-7777-4777-8777-777777777771');
 assert jsonb_array_length(rows)=1 and (rows->0->>'is_default')::boolean,'first auto-default';
 b:=(public.change_member_address('77777777-7777-4777-8777-777777777771','create',null,'{"full_name":"B","address_line":"test B","postal_code":"000002"}')->>'id')::uuid;
 rows:=public.read_member_addresses('77777777-7777-4777-8777-777777777771');
 assert rows->0->>'id'=a::text,'additional insert preserves default';
 perform public.change_member_address('77777777-7777-4777-8777-777777777771','default',b);
 rows:=public.read_member_addresses('77777777-7777-4777-8777-777777777771');
 assert rows->0->>'id'=b::text and (rows->0->>'is_default')::boolean,'switch default';
 assert (select count(*) from jsonb_array_elements(rows) item where (item->>'is_default')::boolean)=1,'exactly one default';
 other_id:=(public.change_member_address('77777777-7777-4777-8777-777777777772','create',null,'{"full_name":"Other","address_line":"other buyer","postal_code":"000003"}')->>'id')::uuid;
 assert public.change_member_address('77777777-7777-4777-8777-777777777771','default',other_id) is null,'cannot select another owner address';
 set constraints profiles_default_address_owner_fk immediate;
 begin update public.buyer_profiles set default_address_id=other_id where user_id='77777777-7777-4777-8777-777777777771';raise exception 'cross-owner reference accepted';exception when foreign_key_violation then null;end;
 perform public.change_member_address('77777777-7777-4777-8777-777777777771','delete',b);
 rows:=public.read_member_addresses('77777777-7777-4777-8777-777777777771');
 assert jsonb_array_length(rows)=1 and rows->0->>'id'=a::text and (rows->0->>'is_default')::boolean,'delete promotes next';
 -- Legacy deletion remains compatible while old/new Worker versions overlap.
 delete from public.buyer_addresses where id=a;
 assert (select user_id is not null and default_address_id is null from public.buyer_profiles where user_id='77777777-7777-4777-8777-777777777771'),'legacy delete clears pointer only';
 assert public.read_member_addresses('77777777-7777-4777-8777-777777777771')='[]'::jsonb,'empty list';
end $$;
reset role;
set local role authenticated;
do $$begin
 begin perform public.change_member_address('77777777-7777-4777-8777-777777777771','default',null);raise exception 'member can call service RPC';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
select 'PASS: first/default switch/single selection/delete fallback/legacy delete/owner isolation/service-only RPC; fixtures rolled back' as result;
