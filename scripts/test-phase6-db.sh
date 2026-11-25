#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG_BIN=${PG_BIN:-$(dirname "$(command -v pg_ctl)")}
for command in initdb pg_ctl createdb psql; do
  test -x "$PG_BIN/$command" || { echo "PostgreSQL binary missing: $command" >&2; exit 1; }
done
PG_TEST_DIR=$(mktemp -d /tmp/cpwebsite-phase6-test.XXXXXX)
cleanup() {
  "$PG_BIN/pg_ctl" -D "$PG_TEST_DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PG_TEST_DIR"
}
trap cleanup EXIT
"$PG_BIN/initdb" -D "$PG_TEST_DIR/data" -A trust --no-instructions >/dev/null
"$PG_BIN/pg_ctl" -D "$PG_TEST_DIR/data" -o "-F -c listen_addresses='' -k $PG_TEST_DIR" -l "$PG_TEST_DIR/postgres.log" start >/dev/null
PG_PORT=5432
"$PG_BIN/createdb" -h "$PG_TEST_DIR" -p "$PG_PORT" cpwebsite_phase6
PSQL=("$PG_BIN/psql" -h "$PG_TEST_DIR" -p "$PG_PORT" -d cpwebsite_phase6 -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -f tests/phase6-postgres-bootstrap.sql >/dev/null
for migration in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$migration" >/dev/null; done
"${PSQL[@]}" -f tests/phase6-database-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/phase7-database-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/paid-membership-database-acceptance.sql >/dev/null

# Two requests for the same account must reuse one annual purchase and provider key.
"${PSQL[@]}" -c "insert into auth.users(id,email,email_confirmed_at) values('10914a68-95e0-4642-a492-1b11bbc47703','annual-race@example.invalid',now())" >/dev/null
ANNUAL_SQL="select public.prepare_paid_membership_checkout('10914a68-95e0-4642-a492-1b11bbc47703',false,'https://cpvaluemart.com')->>'id'"
"${PSQL[@]}" -Atc "$ANNUAL_SQL" > "$PG_TEST_DIR/annual-1.txt" &
annual_first=$!
"${PSQL[@]}" -Atc "$ANNUAL_SQL" > "$PG_TEST_DIR/annual-2.txt" &
annual_second=$!
wait "$annual_first"
wait "$annual_second"
test -s "$PG_TEST_DIR/annual-1.txt"
cmp -s "$PG_TEST_DIR/annual-1.txt" "$PG_TEST_DIR/annual-2.txt"
"${PSQL[@]}" -f tests/membership-database-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/member-campaign-database-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/membership-points-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/membership-rollout-acceptance.sql >/dev/null
"${PSQL[@]}" -f tests/order-refunds-database-acceptance.sql >/dev/null
# Distinct refund requests race for one slot. Concurrent success delivery is idempotent.
"${PSQL[@]}" -f tests/order-refund-race-fixture.sql >/dev/null
REFUND_ACTOR=6e5ee724-c805-4f65-a051-20de63f3c201
REFUND_ORDER=6e5ee724-c805-4f65-a051-20de63f3c203
for refund_index in 1 2; do
  REFUND_REQUEST="6e5ee724-c805-4f65-a051-20de63f3c21$refund_index"
  REFUND_SQL="set role service_role; select public.prepare_order_refund('$REFUND_ACTOR','$REFUND_ORDER',1,'$REFUND_REQUEST',true,false,jsonb_build_array(jsonb_build_object('sku','REFUND-RACE','quantity',1)))->>'id';"
  "${PSQL[@]}" -Atc "$REFUND_SQL" > "$PG_TEST_DIR/refund-$refund_index.txt" 2>&1 &
  if [ "$refund_index" = 1 ]; then refund_pid_first=$!; else refund_pid_second=$!; fi
done
refund_first_status=0
refund_second_status=0
wait "$refund_pid_first" || refund_first_status=$?
wait "$refund_pid_second" || refund_second_status=$?
test "$refund_first_status:$refund_second_status" = '0:1' || test "$refund_first_status:$refund_second_status" = '1:0'
rg -q 'REFUND_IN_PROGRESS' "$PG_TEST_DIR/refund-1.txt" "$PG_TEST_DIR/refund-2.txt"
REFUND_REQUEST=$(rg --no-filename '^6e5ee724-c805-4f65-a051-20de63f3c21[12]$' "$PG_TEST_DIR/refund-1.txt" "$PG_TEST_DIR/refund-2.txt")
REFUND_SQL="set role service_role; select public.resolve_order_refund('$REFUND_ACTOR','$REFUND_ORDER','$REFUND_REQUEST',false,'re_refund_race','succeeded');"
"${PSQL[@]}" -Atc "$REFUND_SQL" > "$PG_TEST_DIR/resolve-refund-1.txt" &
refund_pid_first=$!
"${PSQL[@]}" -Atc "$REFUND_SQL" > "$PG_TEST_DIR/resolve-refund-2.txt" &
refund_pid_second=$!
wait "$refund_pid_first"
wait "$refund_pid_second"
test "$("${PSQL[@]}" -Atc "select refunded_quantity from public.order_items where order_id='$REFUND_ORDER'")" = 1
test "$("${PSQL[@]}" -Atc "select stock from public.products where id='REFUND-RACE'")" = 11
test "$("${PSQL[@]}" -Atc "select count(*) from public.inventory_movements where source_key='refund:$REFUND_REQUEST:REFUND-RACE'")" = 1
"${PSQL[@]}" <<'SQL' >/dev/null
insert into auth.users(id,email,email_confirmed_at)
values('f4655930-6dcc-406b-8cc7-c3e898d24101','welcome-race@example.invalid',now()-interval '1 day');
insert into public.buyer_addresses(id,user_id,full_name,address_line,postal_code)
values('f4655930-6dcc-406b-8cc7-c3e898d24102','f4655930-6dcc-406b-8cc7-c3e898d24101','Synthetic','Synthetic','123456');
insert into public.buyer_cart_items(user_id,sku,quantity)
values('f4655930-6dcc-406b-8cc7-c3e898d24101','OP-1',5);
insert into public.delivery_rules(id,country_code,shipping_cents,free_threshold_cents,active)
values('welcome-race','SG',390,5000,true);
SQL
WELCOME_SQL="select public.create_welcome_order('f4655930-6dcc-406b-8cc7-c3e898d24101','f4655930-6dcc-406b-8cc7-c3e898d24102',now()-interval '1 day',true,4700)->>'id'"
"${PSQL[@]}" -Atc "$WELCOME_SQL" > "$PG_TEST_DIR/welcome-1.txt" 2>&1 &
welcome_first=$!
"${PSQL[@]}" -Atc "$WELCOME_SQL" > "$PG_TEST_DIR/welcome-2.txt" 2>&1 &
welcome_second=$!
welcome_first_status=0
welcome_second_status=0
wait "$welcome_first" || welcome_first_status=$?
wait "$welcome_second" || welcome_second_status=$?
test "$welcome_first_status:$welcome_second_status" = '0:1' || test "$welcome_first_status:$welcome_second_status" = '1:0'
rg -q 'CHECKOUT_PENDING' "$PG_TEST_DIR/welcome-1.txt" "$PG_TEST_DIR/welcome-2.txt"
test "$("${PSQL[@]}" -Atc "select count(*) from public.orders where user_id='f4655930-6dcc-406b-8cc7-c3e898d24101' and payment_status='pending' and total_cents=4700")" = 1
CAMPAIGN_ID=$("${PSQL[@]}" -Atf tests/member-campaign-race-fixture.sql)
for campaign_race in 1 2; do
  campaign_user="b2c80d05-cbda-4ff2-9085-05691897c10$((campaign_race+1))"
  campaign_address="b2c80d05-cbda-4ff2-9085-05691897c10$((campaign_race+3))"
  CAMPAIGN_SQL="begin; select public.create_campaign_order('$campaign_user','$campaign_address','$CAMPAIGN_ID',now()-interval '1 day',true,4500)->>'id'; select pg_sleep(0.4); commit;"
  "${PSQL[@]}" -Atc "$CAMPAIGN_SQL" > "$PG_TEST_DIR/campaign-$campaign_race.txt" 2>&1 &
  if [ "$campaign_race" = 1 ]; then campaign_pid_first=$!; else campaign_pid_second=$!; fi
done
campaign_first_status=0
campaign_second_status=0
wait "$campaign_pid_first" || campaign_first_status=$?
wait "$campaign_pid_second" || campaign_second_status=$?
test "$campaign_first_status:$campaign_second_status" = '0:1' || test "$campaign_first_status:$campaign_second_status" = '1:0'
rg -q 'CAMPAIGN_UNAVAILABLE' "$PG_TEST_DIR/campaign-1.txt" "$PG_TEST_DIR/campaign-2.txt"
test "$("${PSQL[@]}" -Atc "select public.read_member_campaigns('b2c80d05-cbda-4ff2-9085-05691897c101')#>>'{0,reserved}'")" = 1
# Independent connections contend for the same available points through real RPCs.
"${PSQL[@]}" -f tests/membership-points-race.sql >/dev/null
POINTS_ADMIN=eddbf692-e993-46a7-90d4-23052bce0010
POINTS_BUYER=eddbf692-e993-46a7-90d4-23052bce0011
POINTS_ADDRESS=eddbf692-e993-46a7-90d4-23052bce0012
POINTS_LAUNCH="now()-interval '1 day'"
POINTS_TOTAL=$("${PSQL[@]}" -Atc "select public.quote_points_checkout('$POINTS_BUYER',$POINTS_LAUNCH,true,null,null,100)->>'total'")
"${PSQL[@]}" -Atc "select public.create_points_order('$POINTS_BUYER','$POINTS_ADDRESS',$POINTS_LAUNCH,true,null,null,100,$POINTS_TOTAL)" > "$PG_TEST_DIR/points-order.txt" 2>&1 &
points_order_pid=$!
"${PSQL[@]}" -Atc "select public.adjust_member_points('$POINTS_ADMIN','$POINTS_BUYER',-100,'Concurrent debit',gen_random_uuid())" > "$PG_TEST_DIR/points-adjustment.txt" 2>&1 &
points_adjustment_pid=$!
points_order_status=0
points_adjustment_status=0
wait "$points_order_pid" || points_order_status=$?
wait "$points_adjustment_pid" || points_adjustment_status=$?
test "$points_order_status:$points_adjustment_status" = '0:1' || test "$points_order_status:$points_adjustment_status" = '1:0'
rg -q 'POINTS_LIMIT' "$PG_TEST_DIR/points-order.txt" "$PG_TEST_DIR/points-adjustment.txt"
test "$("${PSQL[@]}" -Atc "select public.read_member_points('$POINTS_BUYER')->>'available'")" = 0
"${PSQL[@]}" -f tests/phase6-concurrency-fixture.sql >/dev/null
CONCURRENT_ORDER=$("${PSQL[@]}" -Atc "insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id) select a.user_id,a.id,1000,0,0,1000,'cs_test_phase6_concurrent' from public.buyer_addresses a limit 1 returning id")
"${PSQL[@]}" -c "insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity) values('$CONCURRENT_ORDER','TEST-1','Acceptance Item','One',1000,1)" >/dev/null
PAYMENT_SQL="select public.apply_test_payment_event('evt_phase6_concurrent','checkout.session.completed',false,'$CONCURRENT_ORDER','cs_test_phase6_concurrent','pi_test_phase6_concurrent',1000,'sgd');"
"${PSQL[@]}" -Atc "$PAYMENT_SQL" > "$PG_TEST_DIR/payment-1.txt" &
first_pid=$!
"${PSQL[@]}" -Atc "$PAYMENT_SQL" > "$PG_TEST_DIR/payment-2.txt" &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
rg -q '"outcome": "paid"' "$PG_TEST_DIR/payment-1.txt" "$PG_TEST_DIR/payment-2.txt"
rg -q '"duplicate": true' "$PG_TEST_DIR/payment-1.txt" "$PG_TEST_DIR/payment-2.txt"
test "$("${PSQL[@]}" -Atc "select count(*) from public.inventory_movements where source_key like 'stripe:evt_phase6_concurrent:%'")" = 1
test "$("${PSQL[@]}" -Atc "select count(*) from public.email_jobs where idempotency_key='order_confirmation/stripe/evt_phase6_concurrent'")" = 1
"$PG_BIN/createdb" -h "$PG_TEST_DIR" -p "$PG_PORT" cpwebsite_backfill
PSQL_BACKFILL=("$PG_BIN/psql" -h "$PG_TEST_DIR" -p "$PG_PORT" -d cpwebsite_backfill -v ON_ERROR_STOP=1 -q)
sed '/^create role /d' tests/phase6-postgres-bootstrap.sql | "${PSQL_BACKFILL[@]}" >/dev/null
for migration in supabase/migrations/*.sql; do "${PSQL_BACKFILL[@]}" -f "$migration" >/dev/null; done
"${PSQL_BACKFILL[@]}" -f tests/phase6-backfill-fixture.sql >/dev/null
"${PSQL_BACKFILL[@]}" -f scripts/ops/backfill-cvm-1005-delivery.sql >/dev/null
if "${PSQL_BACKFILL[@]}" -f scripts/ops/backfill-cvm-1005-delivery.sql >/dev/null 2>&1; then
  echo 'Backfill unexpectedly accepted a duplicate delivery email' >&2
  exit 1
fi
test "$("${PSQL_BACKFILL[@]}" -Atc "select count(*) from public.email_jobs j join public.orders o on o.id=j.order_id where o.order_number=1005 and j.kind='delivery' and j.is_test and j.status='pending'")" = 1
test "$("${PSQL_BACKFILL[@]}" -Atc "select count(*) from public.orders where order_number=1005 and payment_status='paid' and fulfilment_status='Delivered'")" = 1
# Separate orders paying for the same SKU must serialize stock and ledger snapshots.
"${PSQL[@]}" -c "insert into public.products(id,sku,name,variant_name,brand,category_id,image_url,original_image_url,r2_image_url,price_cents,stock,reserved_quantity,status) values('RACE-1','RACE-1','Race','One','Test','acceptance','https://example.invalid/a.jpg','https://example.invalid/a.jpg','https://example.invalid/a.jpg',1000,10,6,'Published')" >/dev/null
for race_index in 1 2; do
 RACE_ORDER=$("${PSQL[@]}" -Atc "insert into public.orders(user_id,address_id,subtotal_cents,shipping_cents,discount_cents,total_cents,stripe_checkout_session_id) select user_id,id,3000,0,0,3000,'cs_test_stock_race_$race_index' from public.buyer_addresses limit 1 returning id")
 "${PSQL[@]}" -c "insert into public.order_items(order_id,sku,product_name,variant_name,unit_cents,quantity) values('$RACE_ORDER','RACE-1','Race','One',1000,3)" >/dev/null
 printf '%s' "$RACE_ORDER" > "$PG_TEST_DIR/race-order-$race_index"
done
for race_index in 1 2; do
 RACE_ORDER=$(cat "$PG_TEST_DIR/race-order-$race_index")
 "${PSQL[@]}" -Atc "select public.apply_test_payment_event('evt_stock_race_$race_index','checkout.session.completed',false,'$RACE_ORDER','cs_test_stock_race_$race_index','pi_test_stock_race_$race_index',3000,'sgd')" > "$PG_TEST_DIR/race-payment-$race_index" &
 if [ "$race_index" = 1 ]; then race_pid_one=$!; else race_pid_two=$!; fi
done
wait "$race_pid_one"
wait "$race_pid_two"
test "$("${PSQL[@]}" -Atc "select stock||':'||reserved_quantity from public.products where sku='RACE-1'")" = '4:0'
test "$("${PSQL[@]}" -Atc "select string_agg(quantity_before::text,',' order by quantity_before desc) from public.inventory_movements where product_id='RACE-1'")" = '10,7'
echo 'PASS: isolated PostgreSQL migrations, Phase 6 recovery/concurrency, Phase 7 order/import, and membership acceptance'
