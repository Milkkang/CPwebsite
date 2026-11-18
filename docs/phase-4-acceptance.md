# Phase 4 acceptance — shared storefront and shopping data

Status: **approved with one manual check deferred**. On 2026-11-19, the user replied `Approved Phase 4` and asked to skip the offline admin save check for now. This is a user-directed exception to that Phase 4 check, not a passing test result.

## Release

- PR: [#8](https://github.com/Milkkang/CPwebsite/pull/8), head `829e648e3348ed6af5110991f45f8acd613d5c17`, merge `2456e71fe2197ca41bc38f38e6fe2a0198e7a1d7`.
- GitHub Phase checks: run `44303655405` (run 44), success for the PR head.
- Cloudflare Worker deployment `9e044223-f886-4534-b9dd-2b5286cde720`, version `2421e0ff-5f3e-4dfa-abf2-81db12d56712`, 100% as of 12:25:53 UTC on 2026-11-18.
- Production domain: [cpvaluemart.com](https://cpvaluemart.com).
- PR [#9](https://github.com/Milkkang/CPwebsite/pull/9) published the acceptance hotfix. Its head was `406abd75170c3a4f34140f37dd99146a3a959309`; GitHub Phase checks run `44411608177` (run 48) passed; merge commit `1114469b18e3a0ab3627b6ff674b3a6ea4c9c7f0` deployed as Worker deployment `1dea5ef1-cab4-4739-907e-181473d5a2f4`, version `3aed83ce-384f-431c-bd53-0baf8cd6ce60`, at 100%.
- PR [#10](https://github.com/Milkkang/CPwebsite/pull/10) published the recent-history follow-up. Its head was `0b5ec5e61de68be2c8023373022c3c78f0277cde`; GitHub Phase checks run `44413811409` (run 52) passed; merge commit `8c5f267ef892359cd252dbd90ed3cb18ca4f34e7` deployed as Worker deployment `b31c2b38-2dd6-46b9-aee4-7da38399a985`, version `0f08c1dd-ac6d-4b30-9eed-ca8a6d21b52a`, at 100%.

## Data changes

- Applied migration `20261118121253_phase4_member_shopping`: member cart, saved items and recent products, with service-only cart quantity and guest merge functions. Cart writes recheck published status, MOQ and available stock.
- Applied migration `20261118121501_phase4_admin_catalog_writes`: admin role and expected version checks; stock adjustments and inventory movement records commit in one transaction.
- Applied migration `20261118121913_phase4_catalog_brands`: published brand facet function for server-side filters.
- All new shopping tables began empty. No buyer address data was read or changed.
- A synthetic member cart write, merge and removal were verified inside a rollback transaction; afterward the synthetic user and cart row counts were zero. Synthetic product creation and inventory ledger, version increment and stale-version rejection were verified inside rollback transactions; afterward the synthetic product and movement counts were zero.
- Two synthetic `.invalid` members were used in a rollback transaction to confirm the second member could not read the first member's cart, saved item or recent product. Both synthetic users and carts were absent afterward.

## Automated and read-only production checks

- `npm test`: 29 tests pass, including API input and owner binding, admin actor and version handling, catalog mapping, facet and offers privileges, and the product-detail loading transition used for recent history.
- `npm run build`: pass.
- `npm run test:runtime`: 2 real Worker runtime tests pass (the local loopback binding needed a sandbox exception).
- Browser refresh on the production domain showed the new storefront banner, ten homepage products, 678 catalog products, 30/50/100 products per page, five desktop grid columns, and a product detail using API price, available stock and MOQ.
- In the existing authenticated browser session, the live Admin Products page loaded 678 database products and the Homepage editor loaded the shared banner settings. No live admin values were changed during this read-only check.
- The Cloudflare deployment API showed the new Worker version at 100%.
- The production `/api/health` endpoint returned HTTP 200 with `phase: 4` in the browser.
- Database privilege checks showed `anon` cannot read member carts or execute admin product writes, `authenticated` cannot directly write saved items or execute cart merge, and `anon` can execute only the published brand facet reader. New shopping tables have RLS enabled with no direct client policies; access is through the session-checked Worker and service-only functions.

## Manual acceptance

1. **Passed:** a temporary homepage heading change was saved in the admin browser, appeared in the second browser after refresh, and was restored to the original text.
2. **Passed:** after PR #10 deployed, browser A saved the test product, changed its cart quantity and opened its detail page. After refresh, browser B showed the same saved item, cart quantity and recently viewed product. The test saved item and cart increment were removed afterward; the natural recently viewed entry remains.
3. **Passed:** Chrome added the published test product as a signed-out guest. After sign-in, both authenticated browser sessions returned the merged member cart and the test SKU quantity included the guest addition. The test quantity was restored to its pre-test value. The server-side merge function's rollback verification separately covers unavailable and invalid quantities.
4. **Deferred at the user's request:** the offline admin save and online retry were not manually exercised. On 2026-11-19, the user explicitly approved Phase 4 and subsequently asked to skip this check for now. The code path reports success only after the API returns successfully, but this does not establish actual offline browser behavior. Revisit the check during Phase 8 end-to-end acceptance.

## Scope and recovery

Checkout and payment remain disabled until Phase 5. Admin order, revenue and customer screens still use simulated preview data and are labelled as pending integration. Existing browser preview orders were not imported into production.

For a code rollback, redeploy Worker version `fd846239-9ae5-4c96-8c7a-2545abeb4431` (the last Phase 3 release) while keeping the additive Phase 4 database objects in place. Reverting the Phase 4 migration tables would remove member shopping data and needs a separate backup and migration plan; no destructive rollback is part of this release.
