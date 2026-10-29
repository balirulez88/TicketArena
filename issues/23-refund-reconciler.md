# 23: Refund reconciler and manual review

**What to build:** no refund obligation is forgotten. Stale obligations are re-emitted automatically and, after repeated failure, escalated to manual review, from which an operator can retry them. Spec: Refund obligations and reconciliation.

**Blocked by:** 20

**Status:** ready-for-agent

- [ ] Reconciler (worker, every 5 min): `REFUND_REQUESTED` rows older than 10 min re-emit `payment.refund_requested` via the outbox and increment `refundAttempts`.
- [ ] After 3 re-emits the row moves to `MANUAL_REVIEW`.
- [ ] `BookingService.retryRefund` moves `MANUAL_REVIEW` → `REFUND_REQUESTED` and re-emits.
- [ ] `refund_pending_age_max` is computable for the dashboard.
- [ ] AT-24: re-emit after 10 min; `MANUAL_REVIEW` after 3 re-emits; retry moves it back.
