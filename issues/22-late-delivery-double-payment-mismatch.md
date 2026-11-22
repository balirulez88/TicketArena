# 22: Late delivery, double payment and amount mismatch

**What to build:** an on-time payment delivered a little late still confirms. An on-time payment delivered after the order expired is refunded and counted. A second charge on one order is refunded, and a payment with the wrong amount never confirms. Spec: Payment saga (matrix); ADR 0006.

**Blocked by:** 20

**Status:** in-progress

- [x] On time is `capturedAt <= paymentDeadline`, independent of delivery time.
- [x] A refund caused by an on-time payment delivered after expiry increments `late_delivery_refund`.
- [x] `+double@` captures twice with two payment ids.
- [x] AT-18: on time but delivered after grace → order `EXPIRED`, refund requested, `late_delivery_refund` incremented.
- [x] AT-19: on time, delivered within grace → `CONFIRMED`.
- [x] AT-21: second payment on a confirmed order → refunded; exactly one `APPLIED`.
- [x] AT-22: amount or currency mismatch → refund, not confirmation.
- [x] The best-effort nature of the grace period is documented.
