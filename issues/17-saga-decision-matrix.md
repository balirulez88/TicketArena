# 17: Saga decision matrix

**What to build:** every payment event is handled by one explicit, pure decision over (order state, ledger, event), so duplicates, invalid events and not-yet-applicable events are told apart, and zero-row updates are never mistaken for success. Spec: Payment saga (matrix); ADR 0006, ADR 0007.

**Blocked by:** 08

**Status:** ready-for-agent

- [ ] Pure `decide(orderState, ledger, event, T)` returns `transition | noop | refund | retry | poison`, with a reason code for every `noop`.
- [ ] The booking-saga handler: dedupe check → lock order → `T = clock.now()` → `decide` → apply → `processed_messages` → outbox, one transaction.
- [ ] `poison` for an unknown `orderId`; `retry` maps to the runner's delayed-retry outcome.
- [ ] The confirmation path from ticket 08 runs through `decide` with unchanged behaviour, still writing the order and its `APPLIED` row atomically.
- [ ] AT-25: one unit test per matrix cell, including the poison cases. Cells whose side effects are built by later tickets are asserted on the decision only.
