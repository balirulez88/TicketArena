# 05: Place order

**What to build:** a buyer with a valid hold checks out with an email (phone optional) and gets an order in `PENDING_PAYMENT` with a fixed 5-minute payment deadline; the seats move to `IN_CHECKOUT` and an `order.placed` event is written in the same transaction. Spec: Placing an order.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Order schema (`holdId` unique, contact, `totalMinor`, `currency`, `status`, `paymentDeadline`, `idempotencyKey`, `requestHash`, `correlationId`; unique `(sessionId, idempotencyKey)`) and order lines with prices copied at placement.
- [ ] Lock order: hold `FOR UPDATE`, then seats `ORDER BY id FOR UPDATE`, then `T = clock.now()`.
- [ ] Validates: hold owned by the caller's `BuyerKey` (else `NOT_FOUND`), status `HELD`, `T < holdExpiresAt` (else `HOLD_EXPIRED`), every seat still `HELD` with this `holdId`.
- [ ] Creates the order with `paymentDeadline = T + 5 min`, the hold's `correlationId`; hold → `ORDERED`; seats → `IN_CHECKOUT`; outbox `order.placed` (contract in `contracts`).
- [ ] A repeated call with the same `idempotencyKey` returns the same order.
- [ ] `booking.placeOrder` and `booking.getOrder` (owner only) via tRPC; does not require admission.
