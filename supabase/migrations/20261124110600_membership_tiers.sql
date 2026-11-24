begin;

create index membership_delivered_spend_idx on private.membership_point_earnings(user_id,credited_at desc)
 where credited_at is not null;

create function private.membership_qualifying_spend(p_user uuid,p_at timestamptz)
returns bigint language sql stable set search_path='' as $$
 select coalesce(sum(greatest(0,o.subtotal_cents-o.discount_cents-coalesce(r.amount,0))),0)
 from private.membership_point_earnings e
 join public.orders o on o.id=e.order_id
 left join lateral (
  select sum(f.merchandise_cents) as amount from private.order_refunds f
  where f.order_id=o.id and f.status='completed' and f.resolved_at<=p_at
 ) r on true
 where e.user_id=p_user and o.live_payment and o.member_points_eligible
  and e.credited_at>((p_at at time zone 'Asia/Singapore')-interval '12 months') at time zone 'Asia/Singapore'
  and e.credited_at<=p_at
$$;

create function private.membership_tier_rate(p_spend bigint)
returns integer language sql immutable set search_path='' as $$
 select case when p_spend>=80000 then 150 when p_spend>=30000 then 125 else 100 end
$$;

create or replace function private.membership_points_multiplier(p_user uuid)
returns integer language sql stable set search_path='' as $$
 select coalesce(private.membership_tier_rate(private.membership_qualifying_spend(p_user,
  nullif(current_setting('cvm.tier_paid_at',true),'')::timestamptz)),100)
$$;

create function public.read_membership_tier(p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'tier',case rate when 150 then 'gold' when 125 then 'silver' else 'base' end,
  'qualifyingSpend',spend,'multiplier',rate,
  'nextTier',case rate when 100 then 'silver' when 125 then 'gold' end,
  'nextThreshold',case rate when 100 then 30000 when 125 then 80000 end)
 from private.membership_qualifying_spend(p_user,statement_timestamp()) as spend
 cross join lateral private.membership_tier_rate(spend) as rate
$$;

-- Bind the signed provider payment time to this call, so delayed delivery of
-- Stripe events cannot select a later tier or change a previously booked award.
create function public.apply_tier_payment_event(
 p_event text,p_type text,p_livemode boolean,p_order uuid,p_session text,p_intent text,
 p_amount integer,p_currency text,p_paid_at timestamptz,p_tiers_launch timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text:=current_setting('cvm.tier_paid_at',true);
begin
 if p_livemode is distinct from true or p_type not in ('checkout.session.completed','checkout.session.async_payment_succeeded')
   or p_paid_at is null or p_tiers_launch is null or p_paid_at<p_tiers_launch
   or p_paid_at>clock_timestamp()+interval '5 minutes' then
  raise exception using errcode='22023',message='INVALID_TIER_PAYMENT';
 end if;
 perform set_config('cvm.tier_paid_at',p_paid_at::text,true);
 result:=public.apply_test_payment_event(p_event,p_type,p_livemode,p_order,p_session,p_intent,p_amount,p_currency);
 perform set_config('cvm.tier_paid_at',coalesce(previous,''),true);
 return result;
end $$;

revoke all on function private.membership_qualifying_spend(uuid,timestamptz),private.membership_tier_rate(bigint),
 private.membership_points_multiplier(uuid) from public,anon,authenticated,service_role;
revoke all on function public.read_membership_tier(uuid),
 public.apply_tier_payment_event(text,text,boolean,uuid,text,text,integer,text,timestamptz,timestamptz)
 from public,anon,authenticated;
grant execute on function public.read_membership_tier(uuid),
 public.apply_tier_payment_event(text,text,boolean,uuid,text,text,integer,text,timestamptz,timestamptz) to service_role;

commit;
