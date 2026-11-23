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
"$PG_BIN/createdb" -h "$PG_TEST_DIR" -p "$PG_PORT" cpwebsite_order_delivery
PSQL_DELIVERY=("$PG_BIN/psql" -h "$PG_TEST_DIR" -p "$PG_PORT" -d cpwebsite_order_delivery -v ON_ERROR_STOP=1 -q)
sed '/^create role /d' tests/phase6-postgres-bootstrap.sql | "${PSQL_DELIVERY[@]}" >/dev/null
for migration in supabase/migrations/*.sql; do
 if [[ "$migration" == supabase/migrations/20261122222057_order_delivery_snapshots.sql ]]; then
  "${PSQL_DELIVERY[@]}" -f tests/order-delivery-legacy-fixture.sql >/dev/null
 fi
 "${PSQL_DELIVERY[@]}" -f "$migration" >/dev/null
done
"${PSQL_DELIVERY[@]}" -f tests/order-delivery-database-acceptance.sql >/dev/null
echo 'PASS: isolated PostgreSQL migrations, Phase 6 recovery/concurrency, Phase 7 order/import and order delivery acceptance'
