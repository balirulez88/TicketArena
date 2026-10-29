# 19: Refund obligation for a late capture

**What to build:** money captured after the payment deadline is never kept. The booking saga expires the order, frees the seats and creates a durable refund obligation in the same transaction, and never reclaims seats. Spec: Payment saga, Refund obligations; ADR 0006.

**Blocked by:** 17, 15

**Status:** ready-for-agent

- [ ] `+late@` makes Payment capture after the deadline.
- [ ] `PENDING_PAYMENT` + `succeeded` with `capturedAt > paymentDeadline` → `EXPIRED`, seats freed, `order.expired`, ledger row `REFUND_REQUESTED` with `refundRequestedAt`, outbox `payment.refund_requested` (with contact), one transaction.
- [ ] `EXPIRED` or `CANCELLED` + any `succeeded` → refund obligation.
- [ ] AT-20: a capture after the deadline is refunded and the seats are not reclaimed, even if still free.
