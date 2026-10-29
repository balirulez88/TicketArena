# 16: Checkout idempotency hardening

**What to build:** a checkout retried by the browser, sent twice concurrently, or replayed later always yields the same single order, and a reused key with a different request is rejected. Spec: Placing an order (step 1); ADR 0007.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] `requestHash` is computed from the canonical request (hold id, contact).
- [ ] Same key and hash → the original order, even after the hold has expired.
- [ ] Same key, different hash → `IDEMPOTENCY_KEY_REUSED`.
- [ ] A concurrent duplicate that loses the unique-constraint race re-reads and returns the winner's order.
- [ ] AT-12: same key, same request → same order; concurrent duplicates → one order.
- [ ] AT-13: same key, different request → `IDEMPOTENCY_KEY_REUSED`.
