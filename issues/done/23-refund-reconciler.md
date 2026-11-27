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
