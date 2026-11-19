# Phase 6 acceptance — Resend transactional email

Status: **implementation in progress; not approved**. Phase 6 must not be treated as released or accepted until the migration, protected configuration, Preview, delivery events, manual checks and production verification below are complete and the user explicitly replies `Approved Phase 6`.

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

- `npm test`: 44 tests passed.
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

- Draft PR: [#18](https://github.com/Milkkang/CPwebsite/pull/18); initial implementation head `4ec72b3dd867b1f7fc11e9b004b6550e64eb7dc7`; merge SHA pending.
- GitHub Actions Phase checks run `44528482629` (run 83): success.
- Preview-fix code head `c068f8baa17f0ba8e907016b3aa75fc7eca05494`; GitHub Actions Phase checks run `44543021894` (run 85): success.
- Initial Cloudflare Preview build `4c72e9fd-a7d2-403d-910b-a91c5331d8d0` failed after compiling successfully because Preview uploads reject the `triggers` field. Scheduled triggers are now production-only.
- Replacement Cloudflare Preview build `af8f74c0-9018-46dd-8d65-0236720ff283`, version `004144b9`, status `Ready`.
- Preview URL: <https://feature-phase-6-email-jobs-cpwebsite.milkkang93.workers.dev>. Homepage and `/api/health` returned HTTP 200; health reported `phase: 6`.
- Supabase migration application: not performed.
- Resend webhook/configuration: not performed.
- Production deployment and health: not performed.
- Manual acceptance: not performed.

## Rollback

- Disable the cron trigger or remove the email API key binding to stop sending; pending jobs and audit records remain intact.
- Redeploy the last Phase 5 Worker version for code rollback.
- Do not drop email tables or delete order, payment, inventory, webhook, job, attempt, suppression or delivery-event records as part of code rollback.
- The migration is additive. A destructive database rollback requires separate approval and a data-retention plan.
