# 15: Order expiry after the payment deadline and settlement grace

**What to build:** an order that is never paid releases its seats once the payment deadline plus a 60-second settlement grace has passed, and the buyer is told by email. Seats in checkout are never freed by any other path. Spec: Expiry (orders); ADR 0006.

**Blocked by:** 14, 09

**Status:** ready-for-agent

- [ ] Sweeper: `PENDING_PAYMENT` orders with `paymentDeadline + 60s <= T` (`SKIP LOCKED`) → `EXPIRED`, seats → `AVAILABLE`, outbox `order.expired` (with contact), in one transaction.
- [ ] `IN_CHECKOUT` seats are freed only in the same transaction as the order transition that ends checkout.
- [ ] Notification consumes `order.expired` and records an expiry email.
- [ ] AT-10: `IN_CHECKOUT` seats are not freed by lazy expiry or by the hold sweeper after the original hold expiry; they are freed only at `paymentDeadline + grace`.
- [ ] AT-04 (second part): after the order expires, the buyer's usage drops.
