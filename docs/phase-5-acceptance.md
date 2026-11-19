# Phase 5 acceptance — Stripe sandbox orders

Status: **approved**. On 2026-11-19, the user completed a Stripe sandbox payment and replied `Approved Phase 5` after the production order, webhook, cart and inventory results were verified.

## Release

- PR [#12](https://github.com/Milkkang/CPwebsite/pull/12) added the Stripe test checkout foundation. Head `2a768543f447160b5792549d2a068d0d89d63da2`; merge `1523b0643e24c03dfe2506acc86be26b51d2c269`; Phase checks run `44449446014` (run 59) passed.
- PR [#13](https://github.com/Milkkang/CPwebsite/pull/13) refreshed member cart and order state after the Stripe return. Head `6a88f3116a1a6a956692ab7b9cdbc40482b471fc`; merge `759fc8e7478d5e071db0bbb7ea2db5ce12c03649`; Phase checks run `44456005469` (run 64) passed.
- PR [#14](https://github.com/Milkkang/CPwebsite/pull/14) removed guest baskets and prevented legacy guest-cart replay on refresh. Head `3f2f5b22289d074c7df8c81964655aaa4b74ec54`; merge `7da4935c147dd4f3f6b4dedd308e14d951236eab`; Phase checks run `44457952912` (run 70) passed.
- Cloudflare Worker deployment `ed5fb69d-47a4-45bb-8937-3c35f84d6938`, version `2e54f179-d5b4-45fc-ae45-f7676b31202b`, serves 100% of production traffic. The deployed `app.js` and `shop.js` hashes matched the merged release.
- Production `/api/health` returned HTTP 200 with `phase: 5`.

## Data and payment controls

- Applied migration `20261119090000_phase5_test_orders`: orders, immutable item and delivery snapshots, payment and fulfilment states, Stripe webhook event idempotency, inventory movements and service-only order functions.
- Checkout requires a verified member and a saved Singapore address. The server recalculates SGD totals from the current catalog, MOQ, stock, delivery rule and coupon.
- The Worker accepts only Stripe test credentials and rejects live-mode webhook events. Browser totals and the success page cannot mark an order paid.
- The signed webhook validates the order, Checkout Session, amount and currency before committing payment state, inventory and cart clearing in the database.
- Anonymous and authenticated database roles cannot directly read or mutate orders, webhook events or service-only order functions.
- Guest baskets are disabled. Legacy browser basket data is discarded before authenticated shopping data is loaded, so refresh cannot repeatedly merge quantities.

## Verification

- `npm test`: 37 tests passed after the final basket guard, including checkout authorization, server totals, Stripe test-mode enforcement, webhook signature validation, live-mode rejection, idempotency, return-page behavior and guest basket blocking.
- `npm run build`: passed.
- `npm run test:runtime`: 2 real Worker runtime tests passed.
- `git diff --check`: passed.
- Production checkout displayed Stripe sandbox warnings and used Stripe-hosted Checkout. No real card or live payment was used.
- The accepted order `CVM-1003` was stored as `paid` and `Processing`; its webhook event was `checkout.session.completed`, `livemode=false`, with outcome `paid`.
- The accepted order had one webhook record and one matching inventory movement for its single item line. Inventory arithmetic was valid and the member cart contained zero rows afterward.
- The production basket displayed zero items and an empty basket after webhook processing.

## Scope and recovery

Phase 5 remains test-only. Test orders must not be included in real revenue, and no live Stripe credential or real payment is supported. Transactional email delivery is Phase 6.

For a code rollback, redeploy the preceding Worker version `b62d3ac9-0e6b-4d22-8e22-db8c8c558bfa`. Keep the additive Phase 5 database objects and payment audit records in place; deleting orders, webhook records or inventory movements is not part of a code rollback.
