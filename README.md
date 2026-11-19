# CP Value Mart · Soft Grocery Preview

Source export of the existing CP Value Mart Sites design preview, including the storefront, admin dashboard and product images.

## Run locally

Serve the `dist/` directory with a static HTTP server, for example:

```sh
python3 -m http.server 8080 --directory dist
```

Then open http://localhost:8080. No build or dependency installation is required.

## Preview data

This is an interactive design prototype. Product prices, stock, orders and sign-in are simulated; browser-local changes are stored in localStorage. There is no production database, live payment processing or real order service connected.

## Source

Exported from Sites project `appgprj_6afbc995114c8191b7d0d5fe9a8e7629` at commit `1836d4c7f1cd493c4a1932d07ab4cba3665e9b9e`.

The `.openai/hosting.json` file records the original Sites project configuration. Uploading this source does not enable GitHub Pages or redeploy the original site.

## Product editing

In Admin → Products, edit a variant name, price or MOQ and leave the field to save. Status changes save immediately. These edits remain in the same browser after refresh.

The product editor keeps the R2 image URL in Product information. Changing it replaces an unchanged variant image; an explicitly changed variant image takes precedence. New products start with no variants; use Add variant before saving.

Run the product editing regression checks with Node.js:

```sh
node tests/product-editing.mjs
```

## Phase 1 backend and deployment

Install with `npm ci` using Node 22.23+ (22.x), 24.22+ (24.x), or 26.12+ (26.x).
`npm test` runs API and storefront regression checks. `npm run build` packages the
Worker and verifies that every existing storefront asset is copied byte for byte.
`npm run dev` runs the Worker and storefront locally.

Cloudflare Builds deploys `main` to the existing `cpwebsite` Worker. Build command:
`npm test && npm run build`; deploy command: `npm run deploy` (uses verified prebuilt output).
GitHub pull requests run the same checks before merge. Configuration is in
`cloudflare.config.ts`; the front end remains vanilla JavaScript in `dist/`.

`GET /api/health` is a liveness check, not a database/payment readiness check.
Phase 2 adds read-only product, category and public configuration APIs; unknown API routes return JSON 404. Business data still uses the
existing browser-local preview implementation until later phases.

Configure runtime secrets in Cloudflare Worker Settings → Variables and Secrets,
never Builds variables. Do not commit `.env`, `.dev.vars`, secret values, tokens,
or database exports. No service secret is needed for this phase's liveness API.
See `docs/phase-1-acceptance.md` for validation, limitations and recovery.

## Phase 2 database catalog

Production database: Supabase cpvaluemart-production (Singapore). The storefront
still uses its original preview data until Phase 4. No buyer/admin writes are
accepted by the new API. Read endpoints: `/api/products`, `/api/products/:sku`,
`/api/categories`, `/api/config`. Catalog accepts `q`, `category`, `brand`,
`sort=featured|price-up|price-down|name`, `size=30|50|100` and positive `page`.

`npm run data:prepare` regenerates the checked, idempotent initial seed and report.
Apply the tracked migration before the seed; `supabase/phase-2-verification.sql`
checks production constraints/RLS inside a rolled-back transaction. The browser
export and read-only difference tool are in `scripts/migration/`. See
`docs/phase-2-acceptance.md` for import boundaries, acceptance and recovery.

## Phase 3 accounts

Email/password accounts are handled by Supabase Auth through the same-domain API.
Runtime `SUPABASE_SECRET_KEY` is required; never add it to Builds or the browser.
The browser receives an opaque HttpOnly session cookie, not Supabase tokens. Sessions
last at most one hour; expiry requires sign-in again. Profile/address ownership and
administrator access are checked on the server. TokenHash callbacks are served at
`/auth/confirm` and `/auth/reset`; GET does not consume a link.

Old browser-local identities are ignored. Shared product editing remains Phase 4;
the simulated order submission is disabled until the real test checkout is ready.
See `docs/phase-3-acceptance.md` for configuration, tests and remaining real-mail checks.

## Phase 4 shared storefront

Authenticated carts, saved items and recently viewed products are shared through the same-domain API. Admin product, homepage, delivery and coupon writes use server-verified roles and optimistic versions. See `docs/phase-4-acceptance.md`.

## Phase 5 Stripe test checkout

Checkout remains test-only. The Worker accepts only a `sk_test_` runtime key, recalculates orders from the member cart and saved address, and redirects to a Stripe-hosted test Checkout Session. A signed, idempotent webhook commits stock and payment state; browser totals and success redirects never mark an order paid. Stripe secrets belong only in Cloudflare Runtime Secrets. No live key, real card or real revenue is supported.

Phase 5 is approved. Guest baskets are disabled, authenticated basket state is loaded from the database without replaying browser quantities, and the production sandbox payment, cart clearing and single inventory movement were verified. See `docs/phase-5-acceptance.md`.
