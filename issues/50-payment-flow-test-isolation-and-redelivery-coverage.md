# 50: Payment-flow test isolation and notification redelivery coverage

**What to build:** the end-to-end payment and notification tests prove what the saga and refund tickets will build on: each test sees only its own messages, a failed notification is really redelivered and resumed, and a repeated `order.placed` has a specified outcome. Resolves TD-072, TD-062, TD-065 and TD-053 in `docs/technical-debt.md` (LOW, VERIFICATION). Spec: Payments, Notifications; ADR 0007, ADR 0011.

**Type:** test

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-072: each test in `apps/worker/src/payment-flow.test.ts` runs with its own consumers (or stream prefix), or drains them before stopping its worker, so no test receives another test's event; the AT-14/AT-15 assertions hold as exact counts without scoping deliveries to work around leakage.
- [ ] TD-062: a notification whose send fails is redelivered as the same message after the `nak` (same message id), and a partial failure (EMAIL sent, then the SMS send fails) ends, after redelivery, with both channels `SENT` under the same keys and no duplicate delivery; the dead `.catch(() => undefined)` is gone.
- [ ] TD-065: the `+dup@` flow asserts exactly one `order.confirmed` outbox row for the order and a notification count that stays the same once the outbox is published.
- [ ] TD-053: a redelivered `order.placed` under a new event id for an order that already has a payment attempt has a specified, tested outcome in the Payment consumer (an idempotent skip, or a failure whose redelivery outcome is asserted), and an invalid `order.placed` payload is tested too.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 50 (TD-053, TD-062, TD-065, TD-072) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
