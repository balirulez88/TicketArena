# 18: Payment failure and cancellation

**What to build:** a definitively failed payment cancels the order, frees its seats and tells the buyer; a failed attempt that is not final leaves the order open until its deadline. Spec: Payment saga, Mock Payment service; ADR 0006.

**Blocked by:** 17, 09

**Status:** ready-for-agent

- [ ] Payment records failed attempts (CHECK `FAILED ⇔ failureReason IS NOT NULL`) and emits `payment.failed` with `final`.
- [ ] `+fail@` emails produce `final: true`; Payment never emits `final: true` while another attempt is in flight or captured (module test).
- [ ] `failed` + `final` + `PENDING_PAYMENT` + no `APPLIED` → `CANCELLED`, seats freed, `order.cancelled`. Non-final → log and metric, no ledger row.
- [ ] Notification records a cancellation email for `order.cancelled`.
- [ ] AT-16: final failure → `CANCELLED`, seats freed, one cancellation notification.
- [ ] AT-17: non-final failure → order stays `PENDING_PAYMENT`, seats stay `IN_CHECKOUT`.
