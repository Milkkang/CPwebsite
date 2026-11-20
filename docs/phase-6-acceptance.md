# Phase 6 acceptance — Resend transactional email

Status: **approved; recovery release deployed, production test delivery and signed callback replay verified**. The user explicitly replied `Approved Phase 6` after Preview and `[TEST ORDER]` manual acceptance. PR #18 is merged. Cloudflare CLI OAuth was completed and the production Worker deployed on 2026-11-20 (Singapore time).

## Scope

- Resend remains the transactional email provider.
- All current orders remain Stripe sandbox test orders. Every Phase 6 message is labelled `TEST ORDER` and may be sent only to the protected acceptance-recipient allowlist.
- Order confirmation is queued by the signed Stripe test webhook in the same database transaction that marks payment paid.
- Shipment email is queued by the existing audited `Processing` → `Shipped` admin transition.
- Cancellation and test-refund templates and service-only enqueue support are present, but Phase 6 does not add cancellation or refund operations belonging to Phase 7.
- Email failure never changes the payment result. Duplicate Stripe or Resend webhooks cannot create duplicate jobs or duplicate delivery events.

## Implementation

- Additive migration: `20261119140000_phase6_transactional_email.sql`.
- Persistent tables: `email_jobs`, `email_job_attempts`, `email_delivery_events`, `email_suppressions`.
- RLS is enabled and direct `anon` / `authenticated` access is revoked. Sensitive mutations use service-only RPCs.
- Worker API: `POST /api/resend/webhook`, `GET /api/admin/email-jobs`, `POST /api/admin/email-jobs`.
- Resend webhooks are verified against the raw body with `svix-id`, `svix-timestamp`, `svix-signature`, a five-minute timestamp window and `RESEND_WEBHOOK_SECRET`.
- Database and Resend idempotency use the same stable job key. Automatic attempts are limited to four, with approximately 1-, 5- and 30-minute retry delays. A five-minute lease recovers a Worker interrupted while sending.
- Complaint suppression cannot be bypassed by the admin resend action. A bounced address may be retried only through an explicit admin action.
- The admin order view shows masked recipient, type, state and attempts, and offers resend only for failed or bounced jobs.

## Protected production configuration required

Only names and expected purpose are documented; values must remain in protected platform configuration.

- `RESEND_API_KEY`: restricted Resend sending key for the verified sending domain.
- `RESEND_WEBHOOK_SECRET`: signing secret for the production webhook endpoint.
- `TRANSACTIONAL_EMAIL_TEST_RECIPIENTS`: comma-separated acceptance allowlist; never committed.
- `TRANSACTIONAL_EMAIL_FROM`: `CP Value Mart <orders@notify.cpvaluemart.com>`.
- `TRANSACTIONAL_EMAIL_REPLY_TO`: `orders@notify.cpvaluemart.com`.
- Production Cron trigger: every minute, to claim due retry jobs. Preview omits the trigger because Workers Preview uploads do not support `triggers`.

Before configuration, independently confirm the Resend domain is verified and sending-enabled, the account plan/limits are sufficient, and the production endpoint subscribes to `email.delivered`, `email.bounced`, `email.complained` and `email.failed`.

## Current automated verification

- `npm test`: 45 tests passed.
- `npm run build`: passed; generated Worker configuration contains the one-minute scheduled trigger and secret bindings by name only.
- `npm run test:runtime`: 2 real Worker runtime tests passed.
- `git diff --check`: passed.

Coverage includes allowlist enforcement, provider idempotency, raw-body webhook verification, metadata-only event storage, bounded retry, lease recovery, event ordering, RLS declarations, payment/shipment enqueue points and the controlled admin resend UI.

## Required Preview and manual acceptance

1. Apply the additive migration to the approved test/production Supabase project only after review.
2. Configure protected bindings without exposing values.
3. Create the Resend webhook endpoint and confirm its signature against Preview or the approved endpoint.
4. Complete one Stripe sandbox payment using the approved acceptance recipient. Verify exactly one confirmation job, one provider message and a delivered event.
5. Replay the Stripe event and Resend event. Verify neither replay sends another message or duplicates the audit event.
6. Exercise a temporary retryable failure and confirm no more than four attempts with the expected schedule.
7. Mark the test order shipped and confirm exactly one shipment message. Saving `Shipped` again must not send another.
8. Verify a complaint cannot be resent. Verify a bounced job requires the explicit admin resend action.
9. Confirm no unapproved recipient receives any message and email failure does not alter the paid order.

## Release evidence to complete

- PR: [#18](https://github.com/Milkkang/CPwebsite/pull/18); accepted head `85cf4f7b5c6b74d4bee40c017d66cff99464e9f6`; merge SHA `343f43a` (`Merge pull request #18 from Milkkang/feature/phase-6-email-jobs`).
- GitHub Actions Phase checks run `44528482629` (run 83): success.
- Preview-fix code head `c068f8baa17f0ba8e907016b3aa75fc7eca05494`; GitHub Actions Phase checks run `44543021894` (run 85): success.
- Initial Cloudflare Preview build `4c72e9fd-a7d2-403d-910b-a91c5331d8d0` failed after compiling successfully because Preview uploads reject the `triggers` field. Scheduled triggers are now production-only.
- Replacement Cloudflare Preview build `af8f74c0-9018-46dd-8d65-0236720ff283`, version `004144b9`, status `Ready`.
- Preview URL: <https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev>. Homepage and `/api/health` returned HTTP 200; health reported `phase: 6`.
- Supabase migration `20261119140000_phase6_transactional_email.sql`: applied through the production Supabase SQL Editor; four tables and six service-only RPCs verified, with RLS enabled on all four tables.
- Resend configuration: verified sending domains, configured the protected Preview bindings, and enabled the Preview webhook for delivered/bounced/complained/failed events. Secret values are not recorded here.
- Production configuration: restricted Resend sending key, production webhook signing secret, and the single approved acceptance recipient are present as protected Worker secrets. The verified `notify.cpvaluemart.com` domain is used by the configured From and Reply-To addresses. Secret values are not recorded here.
- Production Resend webhook: `https://cpvaluemart.com/api/resend/webhook`, enabled for `email.delivered`, `email.bounced`, `email.complained` and `email.failed`. The earlier Preview webhook remains enabled and points to the Preview URL.
- Production deployment and health: `npm run deploy` completed with Worker version `e0b28acf-0ecc-40d4-ada9-638645af2900`, both custom domains, and the `* * * * *` schedule. `/api/health` returned HTTP 200 with `phase: 6`; an unsigned POST to `/api/resend/webhook` returned HTTP 400 `INVALID_SIGNATURE`.
- Database audit after deployment: two email jobs and two attempts existed. One Preview acceptance confirmation job was `delivered` with a recorded delivery event; the other was a deliberately failed Preview retry fixture. No production-originated send or signed production webhook delivery has yet been observed.
- Automated verification was repeated after deployment: 45 tests and 2 real Worker runtime tests passed.
- Recovery follow-up: [PR #19](https://github.com/Milkkang/CPwebsite/pull/19) is a draft with an additive migration for paid-order email outbox recovery, expired fourth-attempt leases, early and out-of-order delivery events, duplicate admin resend, and concurrent Stripe replay. Its isolated PostgreSQL acceptance applies every repository migration and uses synthetic orders, fault injection and parallel payment callbacks. The repair migration is not applied to production and the repair Worker is not deployed; production remains on version `e0b28acf-0ecc-40d4-ada9-638645af2900`.
- Manual acceptance: the protected acceptance recipient received one `[TEST ORDER]` message from the Preview admin resend flow, and the user approved Phase 6. Delivery-event replay, retry-failure exercise, shipment transition, complaint suppression and bounced-job override remain represented by automated coverage but were not independently exercised against production.

## Rollback

- Disable the cron trigger or remove the email API key binding to stop sending; pending jobs and audit records remain intact.
- Redeploy the last Phase 5 Worker version for code rollback.
- Do not drop email tables or delete order, payment, inventory, webhook, job, attempt, suppression or delivery-event records as part of code rollback.
- The migration is additive. A destructive database rollback requires separate approval and a data-retention plan.

## Recovery completion verification — 2026-11-20

- Reviewed PR #19 at `0ecae45d951c37a011ac4a479c31602614142655`; its latest GitHub Phase checks run `44635503854` passed. This is not CI evidence for later local changes.
- Corrected the isolated PostgreSQL complaint-suppression assertion so its own failure cannot be swallowed; added a database check that bounced recipients cannot be retried automatically and that an explicit admin resend can claim its audited override child.
- This local revision passed `npm test` (47 tests and product-editing regression), `npm run build`, `npm run test:runtime` (2 tests), `PG_BIN=/opt/homebrew/opt/postgresql@17/bin npm run test:db`, and `git diff --check`. Build/runtime/database checks required a local sandbox exception for sockets; no production database was used by these tests.
- Read-only production preflight: recovery outbox absent; 3 email jobs; 0 pending/sending jobs; 0 duplicate manual parents; 0 unmatched delivery events. Production still serves Worker `e0b28acf-0ecc-40d4-ada9-638645af2900` at 100%.
- Release candidate migration: `20261120070000_phase6_delivery_recovery.sql`, SHA-256 `43a990d3f863390fc0974e3dc16e10cbf11e6d9d714c47fbb90fce533c275911`. It must be applied before the recovery Worker is released. Existing data and audit history remain intact.
- Production release, applying this migration, publishing the new acceptance evidence, and sending an acceptance message are awaiting explicit authorization for this recovery release. No such action has been performed in this completion session.
- After authorization: publish the tested changes to PR #19; confirm latest CI/review and actual Builds trigger behavior; apply the reviewed additive migration once; merge/release once; verify the resulting version, health, cron and rejection of unsigned callbacks. If automatic Builds performs the approved release, do not repeat a CLI production deployment.
- Final production acceptance must observe a `[TEST ORDER]` message sent only to `milkkang93@gmail.com`, its real signed delivery event, and replay without another message. Do not read buyer addresses or credentials. Do not manufacture provider events or expose signing secrets. Keep remaining production/manual checks explicit until independently completed or expressly deferred by the user.
- Rollback remains code-only to Worker `e0b28acf-0ecc-40d4-ada9-638645af2900`; retain recovery schema, existing orders, inventory, jobs and delivery audits. Stop before Phase 7.

## Recovery release and production acceptance — 2026-11-20

- User explicitly authorized publishing the recovery acceptance evidence, applying the reviewed additive migration, merging/releasing once, and sending TEST ORDER acceptance mail only to the designated mailbox. No new Phase approval or Phase 7 work was inferred.
- Published candidate `85ff933859ab647999356cc137bbc5ad1cc03d01` has the same Git tree as locally verified `46099f8`. GitHub Phase checks run `44666751050` (96) passed; Cloudflare Preview `927ff480-5db9-4728-af2b-e41824432992` succeeded for that head.
- Applied `20261120070000_phase6_delivery_recovery.sql` through the production Supabase SQL Editor before releasing the Worker. Verified outbox RLS enabled, anonymous SELECT denied, authenticated reconciliation EXECUTE denied, and service-role reconciliation EXECUTE allowed. Existing three jobs were preserved; no job was active at release preflight.
- PR #19 merged as `063b65cc50c44021c595faa1c559de5238c9106f`. The main push triggered production Build `0630967a-3873-40b9-9b93-de8380082c20`, outcome success. No additional CLI production deployment was performed.
- Production deployment `5d70d834-518d-4255-bac2-a6058697713e` serves Worker `9e5fd734-eaaa-4839-97ce-76a51943bbbe` at 100%. Production health returned `phase: 6`; an unsigned Resend callback was rejected with `INVALID_SIGNATURE`.
- One explicit acceptance job used stable key `order_confirmation/phase6-production-acceptance/063b65c` and an existing paid sandbox order belonging to the designated recipient. The enqueue operation did not create a payment, edit an address, change fulfilment, or alter inventory. Cron claimed and sent it once; the database showed `delivered`, attempt_count 1, one attempt row, one delivered event, is_test true, and the approved-recipient check true.
- Resend provider message `01a1f6fe-9cee-764a-8aa3-221eac7a01ec` carried `[TEST ORDER]`, the configured From/Reply-To, and only the designated acceptance recipient. Actual production event `msg_3MM0hItw7VQ0MOHoqLwmWJ9An1T` received HTTP 200.
- Replayed that genuine event through Resend, without reading or fabricating a signing secret. The supplier showed two successful HTTP attempts and a different Worker request ID for replay. The database still showed one send attempt and one delivered event; the replay sent no additional message.

### Acceptance coverage at closure

| Boundary | Evidence |
| --- | --- |
| Persistent jobs, protected production configuration, scheduled sending, actual delivery | Production migration/permission checks and the single real acceptance delivery above |
| Signed callback, unsigned rejection, duplicate delivery event | Real Resend delivery/replay HTTP 200, unsigned rejection, unchanged one-row event audit |
| Paid-order enqueue failure and concurrent duplicate Stripe callbacks | Isolated PostgreSQL fault injection and parallel callbacks; existing Worker signature/test-mode checks; no new checkout or Stripe replay was initiated in production during this recovery session |
| Retry delays, four-attempt cap, expired final lease, early/out-of-order callbacks | Isolated PostgreSQL acceptance with all migrations; no provider failure was injected in production |
| First shipment transition queues once; saving Shipped again does not enqueue | Isolated PostgreSQL admin transition acceptance; no real order was marked shipped for this recovery session |
| Complaint blocks resend; bounced address requires explicit admin override; repeated admin action deduplicates | Corrected isolated PostgreSQL assertions and service/API checks; no production complaint or bounce was fabricated |
| Confirmation, shipment, cancellation and sandbox-refund templates; recipient restriction | 47 passing tests plus production approved-recipient/is_test checks; cancellation/refund business operations remain Phase 7 |

The recovery release and production delivery/replay gap are closed. Prior historical paragraphs describe their original checkpoints, not current blockers. The table above distinguishes isolated automated verification from real production observations; it does not claim new manual production checkout, shipment, complaint, or failure-injection acceptance. Phase 4 offline-save verification remains deferred to Phase 8. Stop before Phase 7.

Recovery rollback: redeploy Worker `e0b28acf-0ecc-40d4-ada9-638645af2900` only if necessary; preserve all additive schema, orders, inventory and email audit records.
