# Phase 4 acceptance — shared storefront and shopping data

Status: **deployed; manual acceptance in progress**. A local follow-up commit is awaiting explicit publication approval. Do not begin Phase 5 before the user explicitly replies `Approved Phase 4`.

## Release

- PR: [#8](https://github.com/Milkkang/CPwebsite/pull/8), head `829e648e3348ed6af5110991f45f8acd613d5c17`, merge `2456e71fe2197ca41bc38f38e6fe2a0198e7a1d7`.
- GitHub Phase checks: run `44303655405` (run 44), success for the PR head.
- Cloudflare Worker deployment `9e044223-f886-4534-b9dd-2b5286cde720`, version `2421e0ff-5f3e-4dfa-abf2-81db12d56712`, 100% as of 12:25:53 UTC on 2026-11-18.
- Production domain: [cpvaluemart.com](https://cpvaluemart.com).
- Local follow-up commit `49da143` adds Static Assets `Cache-Control: no-store` headers and allows the admin product-name field to retain every existing catalog name. It passes the full test and build suites but has not been published or deployed.

## Data changes

- Applied migration `20261118121253_phase4_member_shopping`: member cart, saved items and recent products, with service-only cart quantity and guest merge functions. Cart writes recheck published status, MOQ and available stock.
- Applied migration `20261118121501_phase4_admin_catalog_writes`: admin role and expected version checks; stock adjustments and inventory movement records commit in one transaction.
- Applied migration `20261118121913_phase4_catalog_brands`: published brand facet function for server-side filters.
- All new shopping tables began empty. No buyer address data was read or changed.
- A synthetic member cart write, merge and removal were verified inside a rollback transaction; afterward the synthetic user and cart row counts were zero. Synthetic product creation and inventory ledger, version increment and stale-version rejection were verified inside rollback transactions; afterward the synthetic product and movement counts were zero.
- Two synthetic `.invalid` members were used in a rollback transaction to confirm the second member could not read the first member's cart, saved item or recent product. Both synthetic users and carts were absent afterward.

## Automated and read-only production checks

- `npm test`: 28 tests pass, including API input and owner binding, admin actor and version handling, catalog mapping, facet and offers privileges.
- `npm run build`: pass.
- `npm run test:runtime`: 2 real Worker runtime tests pass (the local loopback binding needed a sandbox exception).
- Browser refresh on the production domain showed the new storefront banner, ten homepage products, 678 catalog products, 30/50/100 products per page, five desktop grid columns, and a product detail using API price, available stock and MOQ.
- In the existing authenticated browser session, the live Admin Products page loaded 678 database products and the Homepage editor loaded the shared banner settings. No live admin values were changed during this read-only check.
- The Cloudflare deployment API showed the new Worker version at 100%.
- The production `/api/health` endpoint returned HTTP 200 with `phase: 4` in the browser.
- Database privilege checks showed `anon` cannot read member carts or execute admin product writes, `authenticated` cannot directly write saved items or execute cart merge, and `anon` can execute only the published brand facet reader. New shopping tables have RLS enabled with no direct client policies; access is through the session-checked Worker and service-only functions.

## Manual acceptance

1. **Passed:** a temporary homepage heading change was saved in the admin browser, appeared in the second browser after refresh, and was restored to the original text.
2. **Blocked by stale browser assets:** the shopping API returned the new saved item for the verified member, while the second browser still rendered its old local saved list. The test saved item was removed again. The local follow-up commit prevents reuse of old unversioned scripts; repeat saved, recent and cart checks after deployment.
3. **Pending:** guest cart merge on sign-in, including stock and published-status revalidation.
4. **Pending:** an offline admin save must report failure, followed by a successful retry after network recovery.

## Scope and recovery

Checkout and payment remain disabled until Phase 5. Admin order, revenue and customer screens still use simulated preview data and are labelled as pending integration. Existing browser preview orders were not imported into production.

For a code rollback, redeploy Worker version `fd846239-9ae5-4c96-8c7a-2545abeb4431` (the last Phase 3 release) while keeping the additive Phase 4 database objects in place. Reverting the Phase 4 migration tables would remove member shopping data and needs a separate backup and migration plan; no destructive rollback is part of this release.
