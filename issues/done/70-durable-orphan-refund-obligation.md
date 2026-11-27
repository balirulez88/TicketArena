# 70: Durable refund obligation for an unknown order

**What to build:** money captured for an order booking does not know is never forgotten. Today the `unknown_order` refund obligation exists only as a `payment.refund_requested` row in `outbox_events` (the ledger `order_payments` needs an order), so the planned 14-day outbox retention would delete the only record of an open refund, and the ledger reconciler would never see it. Booking gets its own durable orphan obligation, unique per `paymentId` and storable without an order, which `payment.refunded` closes. Spec: Refund obligations; ADR 0006 (recoverable financial obligation). Decided in the review of PR #15 (questions 19/2 and 20/1 in `.devflow/questions.md`).

**Blocked by:** 20 (refund execution)

**Status:** done

**Completed:** 2026-11-27 on devflow/run-202611261713 (run 202611261713)

**Status reason:** after the MVP, but it must land before outbox retention (ticket 27) and the refund reconciler (ticket 23), which both depend on it

- [x] A capture for an unknown `orderId` writes one booking-owned orphan obligation per `paymentId` (amount, currency, `capturedAt`, `REFUND_REQUESTED`) in the same transaction as its `payment.refund_requested` outbox row; a duplicate or concurrent capture event leaves exactly one obligation and one outbox row.
- [x] `payment.refunded` for that `paymentId` moves the orphan obligation to `REFUNDED`; a repeated `payment.refunded` changes nothing; a `payment.refunded` with neither a ledger row nor an orphan obligation is poison.
- [x] Deleting the obligation's `outbox_events` row leaves the open obligation readable with everything needed to re-emit its refund request.
- [x] The `decide()` matrix and the spec's unknown-order cells name the orphan obligation instead of "outbox event only".

## Review of PR #19 (Q15)

Q15 answers, checked against the code:

- One Booking-owned row per `paymentId`, no FK to the order, written with its `payment.refund_requested` outbox row in one transaction: already met.
- Backfill from the earliest request, with `occurredAt` as the historical capture-time proxy: already met in the migration; the proxy is now stated in the migration comment and in `docs/database/index.md`.
- A completed confirmation is recovered through Payment's re-announcement (finding 1): Payment answers a duplicate `payment.refund_requested` by emitting `payment.refunded` again for the refund it already executed, through its outbox in the same transaction, without refunding twice.
- Requests written during the cutover are caught up (finding 2): the refund migrations are expand-only, and every reconciler pass first creates the missing orphan obligation for any `unknown_order` request that has none (`docs/operations/deployment.md`, "Refund cutover").

Tests:

- `apps/worker/src/payment/refund-handler.test.ts` :: "AT-23: a duplicate payment.refund_requested under a new event id refunds nothing twice and re-announces the executed refund"
- `apps/worker/src/payment/refund-handler.test.ts` :: "AT-23: two duplicates that race yield one refund row, announced by each"
- `apps/worker/src/refund-recovery-flow.test.ts` :: "converges to REFUNDED for an orphan obligation, refunded exactly once"
- `apps/worker/src/refund-recovery-flow.test.ts` :: "converges to REFUNDED for a backfilled orphan obligation whose refund had already completed"
- `packages/booking/src/refund-cutover.test.ts` :: "an unknown_order request with no obligation gets one from its earliest request, once"
- `packages/booking/src/refund-cutover.test.ts` :: "leaves an obligation that already exists as it is, even a closed one"
