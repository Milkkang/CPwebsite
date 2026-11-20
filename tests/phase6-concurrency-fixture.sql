create function public.phase6_test_slow_inventory() returns trigger language plpgsql as $$
begin
 if new.source_key like 'stripe:evt_phase6_concurrent:%' then perform pg_sleep(0.4); end if;
 return new;
end $$;
create trigger phase6_test_slow_inventory before insert on public.inventory_movements
for each row execute function public.phase6_test_slow_inventory();
