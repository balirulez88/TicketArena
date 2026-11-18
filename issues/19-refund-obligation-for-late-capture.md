# 19: Refund obligation for a late capture

**What to build:** money captured after the payment deadline is never kept. The booking saga expires the order, frees the seats and creates a durable refund obligation in the same transaction, and never reclaims seats. Spec: Payment saga, Refund obligations; ADR 0006.

**Blocked by:** 17, 15

**Status:** deferred

**Status reason:** frontend chain first (61, 62, 31, 33, 34); restore to ready-for-agent after run

- [ ] `+late@` makes Payment capture after the deadline.
- [ ] `PENDING_PAYMENT` + `succeeded` with `capturedAt > paymentDeadline` → `EXPIRED`, seats freed, `order.expired`, ledger row `REFUND_REQUESTED` with `refundRequestedAt`, outbox `payment.refund_requested` (with contact), one transaction.
- [ ] `EXPIRED` or `CANCELLED` + any `succeeded` → refund obligation.
- [ ] AT-20: a capture after the deadline is refunded and the seats are not reclaimed, even if still free.
- [ ] A captured `payment.succeeded` whose `orderId` no longer exists (for example after a demo reset that predates ticket 64) is refunded instead of poisoned: `payment.refund_requested` with reason `unknown_order` goes into the outbox in the same transaction as the dedupe record, and a redelivered or duplicate message refunds that `paymentId` exactly once. Answer to ticket 17's third question in `.devflow/questions.md`.

**Documentation deliverable (reviewed, not test-verified):** the spec's Payment saga section and the `decide()` matrix say that an unknown `orderId` on a `succeeded` payment is a refund, while an unknown `paymentId` on a refund event stays poison.
