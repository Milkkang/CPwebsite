# CP Value Mart operations

Run the existing native JavaScript frontend and Cloudflare Worker with `npm run dev`. Public catalog access uses Supabase publishable privileges; member/admin APIs resolve opaque server sessions and database roles. Every current order is a Stripe test order. Real revenue remains zero.

## Validation

- `npm test`: API, authentication, catalog, checkout, email, import and browser-state regressions.
- `npm run build`, then `npm run test:runtime`: assets, configured Worker target and real Workers runtime.
- `PG_BIN=/opt/homebrew/opt/postgresql@17/bin npm run test:db`: disposable PostgreSQL only; all migrations, concurrency, refund/restock idempotency, email faults, ownership and atomic imports. Requires local PostgreSQL tools; never set a production database URL.
- `node tests/browser-qa-server.mjs`: isolated synthetic UI at `http://127.0.0.1:8788/#/admin/products`; `/qa` checks actual browser XLSX parsing. `/__qa/offline` toggles failed fixture writes for offline/retry checks. This fixture server is never deployed and never proves production authentication or provider delivery.

## Imports and administration

Products accept the CSV export/template or an unencrypted single-sheet `.xlsx` with the same columns. Limit 2 MB / 1,000 rows; formulas and macros are unsupported. Each variant is a separate listing keyed by its variant SKU. Each new listing needs valid HTTPS image references. Parse/validation occurs before the transactional server import; version conflicts or any invalid row roll back every change and ledger entry. Reload products before retrying a conflict. No original R2 objects are deleted.

Categories are managed under Settings; Brand is maintained on product records and read as a live catalog facet. Search insights aggregate shared server counts, omit email-like terms and enforce per-origin-IP hashed rate limits. Traffic is not collected; the dashboard must not manufacture visitor numbers.

## Deployment and recovery

Cloudflare Builds connects `main` to production, excludes `docs/**`, and can build previews for other branches. Ordinary commits stay on the verified development branch. Do not push main simply to synchronize documentation. Keep CI/protection intact.

Before publishing, verify tests, target account/Worker, current deployment and schema compatibility. Deploy only tested application code; no package upgrades, DNS changes or resource provisioning are needed. Existing Preview `feature-phase-6-email-jobs` uses shared production Supabase: use read-only checks or explicitly identified test workflows, never destructive fixtures there. `npm run preview -- --preview-name feature-phase-6-email-jobs` evaluates the Preview configuration (no cron). Production needs a fresh production build after a Preview build because the generated configurations differ.

Pre-release production code recovery point verified 2026-11-20: Worker version `7610f228-2c87-4150-bf49-959bec9774e5`, deployment `cdf8e869-05f8-4b97-b6bd-94f7567e47e9`. Code-only rollback, if needed:

```sh
./node_modules/.bin/cf workers deployments create --worker cpwebsite --strategy percentage --versions '[{"version_id":"7610f228-2c87-4150-bf49-959bec9774e5","percentage":100}]'
```

Retain all new schema, user/order/stock data, email outbox and audit records. New migrations are compatible with the prior application RPC signatures. Never replay the old baseline migrations based only on version numbers: earlier remotely applied versions differ from repository filenames; verify actual definitions and migration names. Destructive rollback requires a separate backup and approval.

## Test payments and recovery

Checkout creates reservations only for verified emails in protected `TRANSACTIONAL_EMAIL_TEST_RECIPIENTS` or explicitly enabled service-only `checkout_testers`; absent allowlist fails closed. Public browsing remains open. Only `sk_test_` credentials work; signed live events and unconfirmed asynchronous completions are rejected/ignored. The return page cannot prove payment.

Admin cancellation expires the provider Checkout before releasing reservation. A completed Checkout must reconcile its webhook before refunding. Full test refunds verify the original test PaymentIntent, server amount/currency and order metadata; reuse a stable idempotency key and search existing order-tagged refunds on retry. Pending provider results leave the order and inventory unchanged. Retry the same action/restock choice to reconcile a lost response. Shipped/delivered items must be physically available before explicitly selecting restock. Pending refund operations block shipment. Do not manually mark an unverified provider refund complete.

Email failures do not reverse payment/refund/stock results. Durable outbox entries reconcile through the existing one-minute cron; protected recipient restrictions and TEST ORDER labels remain. If a test refund is failed/cancelled at the provider or an unexpected reconciliation conflict remains, retain audit records, inspect the provider state and reconcile deliberately; never issue real funds or delete stock records to clear the error.
