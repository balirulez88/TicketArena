# 23: Refund reconciler and manual review

**What to build:** no refund obligation is forgotten. Stale obligations are re-emitted automatically and, after repeated failure, escalated to manual review, from which an operator can retry them. Spec: Refund obligations and reconciliation.

**Blocked by:** 20, 70 (durable orphan refund obligation)

**Status:** done

**Completed:** 2026-11-27 on devflow/run-202611261713 (run 202611261713)

**Status reason:** after the MVP (scope cut 2026-11-18)

- [x] Reconciler (worker, every 5 min): `REFUND_REQUESTED` rows older than 10 min re-emit `payment.refund_requested` via the outbox and increment `refundAttempts`.
- [x] Open orphan refund obligations (ticket 70) older than 10 min are re-emitted the same way, so a refund for an unknown order is never forgotten.
- [x] After 3 re-emits the row moves to `MANUAL_REVIEW`.
- [x] `BookingService.retryRefund` moves `MANUAL_REVIEW` → `REFUND_REQUESTED` and re-emits.
- [x] `refund_pending_age_max` is computable for the dashboard.
- [x] AT-24: re-emit after 10 min; `MANUAL_REVIEW` after 3 re-emits; retry moves it back.

## Review of PR #19 (Q16, Q17)

- Q16, already met: `refundLastRequestedAt` drives the 10-minute window and the first `refundRequestedAt` drives `refund_pending_age_max`; the third re-emit gets its full 10 minutes, and the obligation moves to `MANUAL_REVIEW` on the next stale pass after it (`packages/booking/src/refund-reconciler.test.ts` :: "moves to MANUAL_REVIEW, emitting nothing, once its third re-emit is 10 minutes old, and stays there").
- Q17: a retry re-emits from `MANUAL_REVIEW`, resets `refundAttempts` to 0 and keeps the first request time (already met); an obligation in another state is `REFUND_NOT_IN_MANUAL_REVIEW` (already met); a missing payment is `NOT_FOUND` (already met). Fixed: an `APPLIED` payment, which owes no refund, was `REFUND_NOT_IN_MANUAL_REVIEW` and is now `NOT_FOUND`. Ticket 36 owns the admin endpoint.
- Finding 1: an obligation whose `payment.refunded` was lost no longer ends in `MANUAL_REVIEW`; Payment re-announces the executed refund on the reconciler's re-emit.
- Finding 2: the reconciler migration is expand-only (no CHECK on `order_payments`), and each pass first completes ledger rows the previous worker wrote without `refundReason` and `refundLastRequestedAt`. The CHECK is deferred to a later contract migration (`docs/operations/deployment.md`, "Refund cutover").

Tests:

- `packages/booking/src/refund-reconciler.test.ts` :: "is NOT_FOUND for an APPLIED payment, which owes no refund, and changes nothing"
- `apps/worker/src/refund-recovery-flow.test.ts` :: "converges to REFUNDED for a ledger obligation, refunded exactly once"
- `packages/booking/src/refund-cutover.test.ts` :: "a ledger row without a reason or a last request gets its request's reason and is re-emitted once stale"
- `packages/booking/src/refund-cutover.test.ts` :: "a ledger row whose request is gone takes the reason its order's status implies"
- `packages/db/src/refund-reconciler-migration.test.ts` :: "accepts the old worker's ledger refund obligation, written without a reason or a last request"
- `packages/db/src/refund-reconciler-migration.test.ts` :: "after a rollback, keeps the old worker's writes working: APPLIED rows, and closing a row the new worker wrote"
