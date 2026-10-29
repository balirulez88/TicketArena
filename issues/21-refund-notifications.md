# 21: Refund notifications

**What to build:** buyers are told when a refund is initiated and when it completes, and every final order outcome results in exactly one notification per channel. Spec: Mock Notification service.

**Blocked by:** 20, 18

**Status:** ready-for-agent

- [ ] Notification consumes `payment.refund_requested` (refund initiated) and `payment.refunded` (refund completed).
- [ ] AT-43: confirmed, cancelled, expired, refund initiated and refund completed each produce exactly one notification record per channel, including under duplicate delivery.
