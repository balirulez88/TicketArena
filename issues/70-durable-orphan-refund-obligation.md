# 70: Durable refund obligation for an unknown order

**What to build:** money captured for an order booking does not know is never forgotten. Today the `unknown_order` refund obligation exists only as a `payment.refund_requested` row in `outbox_events` (the ledger `order_payments` needs an order), so the planned 14-day outbox retention would delete the only record of an open refund, and the ledger reconciler would never see it. Booking gets its own durable orphan obligation, unique per `paymentId` and storable without an order, which `payment.refunded` closes. Spec: Refund obligations; ADR 0006 (recoverable financial obligation). Decided in the review of PR #15 (questions 19/2 and 20/1 in `.devflow/questions.md`).

**Blocked by:** 20 (refund execution)

**Status:** deferred

**Status reason:** after the MVP, but it must land before outbox retention (ticket 27) and the refund reconciler (ticket 23), which both depend on it

- [ ] A capture for an unknown `orderId` writes one booking-owned orphan obligation per `paymentId` (amount, currency, `capturedAt`, `REFUND_REQUESTED`) in the same transaction as its `payment.refund_requested` outbox row; a duplicate or concurrent capture event leaves exactly one obligation and one outbox row.
- [ ] `payment.refunded` for that `paymentId` moves the orphan obligation to `REFUNDED`; a repeated `payment.refunded` changes nothing; a `payment.refunded` with neither a ledger row nor an orphan obligation is poison.
- [ ] Deleting the obligation's `outbox_events` row leaves the open obligation readable with everything needed to re-emit its refund request.
- [ ] The `decide()` matrix and the spec's unknown-order cells name the orphan obligation instead of "outbox event only".
