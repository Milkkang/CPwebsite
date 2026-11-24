-- Keep order references intact and enforce checkout eligibility at the database.
alter table public.coupons
  add column deleted_at timestamptz,
  add constraint coupons_deleted_inactive check (deleted_at is null or not active);
