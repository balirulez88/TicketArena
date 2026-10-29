# 36: Admin live feed, message health and stuck refunds

**What to build:** the dashboard shows a live event stream that can be grouped by booking, the health of message delivery, and the refunds that need attention, with a retry action. Spec: Admin dashboard.

**Blocked by:** 35, 25, 23, 26

**Status:** ready-for-agent

- [ ] `admin.feed(cursor)`: the union of all outbox tables ordered by `(createdAt, id)`, groupable by `correlationId`.
- [ ] The worker health endpoint reports consumer lag, pending acks, redeliveries, DLQ size and oldest DLQ age; the dashboard shows them alongside outbox lag.
- [ ] `admin.stuckRefunds` lists `REFUND_REQUESTED` and `MANUAL_REVIEW` rows with their age; `admin.retryRefund` triggers the retry.
- [ ] The snapshot includes `late_delivery_refund`, `deadlock_retry`, `booking_busy`, `limit_exceeded` and `refund_pending_age_max`.
