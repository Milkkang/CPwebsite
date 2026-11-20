# CP Value Mart final acceptance — 2026-11-20

This is internal engineering acceptance under the autonomous workflow. It does not invent user approval of individual Phases. Current delivery state is maintained only in [STATUS](STATUS.md).

## Verified application

- Original application checkpoint: local `d608a1d`. Final canonical main commit: `ac0c1dfc28b13dad7aa3d537568305c11b07cc34`; GitHub tree SHA exactly matched the full locally verified delivery tree `65c32a1688682036201367da5ac9711815761331`. The original local commit branch is retained.
- Production: https://cpvaluemart.com ; verified application release (the original accepted Worker `2326978e-31e0-4a31-9b43-05a7a19767ec` is retained as a compatible recovery point), health Phase 8.
- Preview: https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev ; deployment `281b7bfd-9ec1-4f56-8784-a3a00d7debf1` verified public catalog, Supabase access and authentication.
- Production public catalog after QA cleanup: 678 listings, 11 categories, 72 brands. All 678 distinct R2 image URLs returned successful image HEAD responses.
- No React migration was attempted: the actual supported frontend remains native JavaScript with a Cloudflare Worker.

## Automated and browser evidence

| Verification | Result |
| --- | --- |
| `npm test` | 58 passing API/UI/import/safety tests, plus product editing/homepage/pagination checks |
| `npm run build` | Exact static asset bytes, Worker target and API routing passed |
| `npm run test:runtime` | 3 passing real Workerd tests, including Stripe session creation and refusing provider redirects |
| `PG_BIN=… npm run test:db` | All migrations in disposable PostgreSQL; duplicate/parallel payment processing, distinct orders sharing stock, correct ledger snapshots, refund/restock replay, cancellation, import rollback, mail fault recovery, receipt ownership and immediate QA admin revocation passed |
| Actual browser XLSX | Compressed workbook preserves SKU/price/columns; formulas rejected; upload/confirmation passes |
| Offline save/retry | Isolated UI showed failure and restored old value; reconnect/retry saved and survived reload |
| Responsive browser QA | Production 1200px desktop, 390px and 320px widths; no document horizontal overflow; no visible broken images. Mobile admin order overflow fixed and rechecked at 390px |

The Stripe redirect regression was observed during actual acceptance, fixed using Workers-supported `manual` redirect mode, and added to real runtime regression coverage. It is not recorded as a passing earlier run.

## Actual production test workflow

The user explicitly authorized a dedicated synthetic buyer and temporary checkout/admin access. Its existing normal login session was used; no production user was impersonated. Authenticated browser testing used a loopback-only proxy with the exact frontend files and actual production APIs, keeping generated credentials out of page text and chat. Stripe-hosted Checkout itself ran on Stripe in visibly labelled Sandbox mode with the public test card.

- Profile and synthetic address, saved item and basket persistence passed.
- QA product create/update, hidden QA category create/update and coupon persistence passed.
- Real transactional import passed; a deliberately invalid second row rolled back the first QA row and stock change.
- QA shipping coupon changed server-calculated delivery from S$3.90 to S$0.00.
- `CVM-1009`: S$1.00 sandbox payment; signed webhook settled it, basket cleared, QA stock changed 5 → 4 and reservation became zero.
- Admin shipment/tracking, buyer-owned receipt confirmation and Delivered status passed.
- Full Stripe sandbox refund and duplicate request passed; order became refunded/Cancelled, stock returned to 5 with exactly one refund inventory movement.
- `CVM-1010`: unpaid provider session cancellation and duplicate request passed; order became failed/Cancelled; stock stayed 5 and reservation zero.
- Earlier transport-failure orders `CVM-1007` and `CVM-1008` remained failed/Cancelled with reservations released.
- Shared server search statistics recorded the synthetic QA search.

## Email and security

- Production protected binding names remain present; signed Stripe/Resend endpoints reject unsigned requests.
- Existing production evidence includes 8 delivered email jobs; the latest delivered job was updated at `2026-11-20T08:06:27Z`.
- New synthetic QA email jobs correctly failed closed with `RECIPIENT_NOT_ALLOWED`; no new external delivery is claimed for these jobs. Durable confirmation/shipment/delivery/refund/cancellation behavior and mail failure recovery were verified.
- New tables have RLS and no public/client grants. Service-only RPC execution and live database permissions were checked.
- Stripe remains test-only. Browsing is public, checkout is explicitly allowlisted, and all test totals remain excluded from real revenue. Visitor traffic is not fabricated.
- Temporary QA admin role was removed and checkout access disabled. The already-issued session immediately received 403 for both admin and checkout, while retaining ordinary buyer account access.
- QA product is Draft, QA coupon inactive, hidden QA category retained, QA basket/saved item cleared. Orders, stock ledger, email records and original acceptance evidence remain intact. No pending QA operations remain.

## Limits and recovery

- Preview has no independent Stripe secret configuration; payment end-to-end acceptance used the controlled production test workflow. Preview payment configuration is not falsely marked verified.
- Supabase reports its existing leaked-password-protection warning. Enabling a paid feature or changing the plan was outside this release; no plan upgrade was performed.
- The code-only rollback procedure and schema/data preservation boundary are in [operations](operations.md). No destructive production restore or real payment was performed.
- Final GitHub [Phase checks run 44707639113](https://github.com/Milkkang/CPwebsite/actions/runs/44707639113) passed. Existing Pages dynamic build also passed. The Cloudflare automatic production build succeeded for the same canonical main SHA. Final production smoke passed after deployment. No per-Phase PR or artificial approval was created.
- Authenticated end-to-end QA ran on manually deployed version `2326978e-31e0-4a31-9b43-05a7a19767ec`; final CI rebuilt the identical application source. Local Git CLI lacked HTTPS write credentials, so the existing GitHub connector published an identical tree as a fast-forward delivery commit. No force push or protection change was used; continued local work is on `dev/autonomous`.
