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
echo 'PASS: Phase 6 isolated PostgreSQL acceptance'
