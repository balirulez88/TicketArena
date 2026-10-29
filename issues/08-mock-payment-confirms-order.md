# 08: Mock payment confirms the order

**What to build:** after checkout, the mock Payment service charges the order and the booking saga confirms it: the order becomes `CONFIRMED`, its seats `SOLD`, and the captured payment is recorded as `APPLIED` in the ledger **in the same transaction** as the confirmation. Duplicate payment events cause no second state change. Spec: Payment saga, Mock Payment service, Data model; ADR 0006, ADR 0009.

**Blocked by:** 06, 07

**Status:** ready-for-agent

- [ ] `payment` schema with its own outbox and `processed_messages`; `payment_attempts` unique `(orderId, attemptNo)` with CHECK `CAPTURED ⇔ capturedAt IS NOT NULL`.
- [ ] The Payment module consumes `order.placed`, records a captured attempt and emits `payment.succeeded` (`paymentId`, `orderId`, `attemptNo`, `amount`, `currency`, `capturedAt`) via its outbox; randomness and latency come from injected `Random`/`Clock`.
- [ ] Booking ledger `order_payments` (`paymentId` PK, `amount`, `currency`, `capturedAt` NOT NULL, `disposition`) with a partial unique index allowing one `APPLIED` per order.
- [ ] The `booking-saga` consumer locks the order and, in one transaction, sets `CONFIRMED`, inserts the `APPLIED` ledger row, sets seats `SOLD`, inserts `processed_messages` and writes `order.confirmed`.
- [ ] A test proves atomicity: a failure injected after the ledger insert leaves neither the `CONFIRMED` order nor the `APPLIED` row.
- [ ] `+dup@` makes Payment publish its result twice; the second delivery causes no state change (first half of AT-14).
- [ ] Integration test: hold → order → worker → `CONFIRMED` with exactly one `APPLIED` row.
