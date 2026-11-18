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
All other `/api/*` routes currently return JSON 404. Business data still uses the
existing browser-local preview implementation until later phases.

Configure runtime secrets in Cloudflare Worker Settings → Variables and Secrets,
never Builds variables. Do not commit `.env`, `.dev.vars`, secret values, tokens,
or database exports. No service secret is needed for this phase's liveness API.
See `docs/phase-1-acceptance.md` for validation, limitations and recovery.
