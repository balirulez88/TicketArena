# 16: Checkout idempotency hardening

**What to build:** a checkout retried by the browser, sent twice concurrently, or replayed later always yields the same single order, and a reused key with a different request is rejected. Spec: Placing an order (step 1); ADR 0007.

**Blocked by:** 05

**Status:** done

**Completed:** 2026-11-18 on devflow/run-202611181233 (run 202611181233)

- [x] `requestHash` is computed from the canonical request (hold id, contact).
- [x] Same key and hash → the original order, even after the hold has expired.
- [x] Same key, different hash → `IDEMPOTENCY_KEY_REUSED`.
- [x] A concurrent duplicate that loses the unique-constraint race re-reads and returns the winner's order.
- [x] AT-12: same key, same request → same order; concurrent duplicates → one order.
- [x] AT-13: same key, different request → `IDEMPOTENCY_KEY_REUSED`.
- [x] TD-043: `placeOrder`'s transaction returns an explicitly tagged result (for example `kind: "created" | "replayed"`), and a test shows a replayed request logs no "order placed" line and returns the original order view.
- [ ] The commit message names, for each of TD-022, TD-043, the test that proves it fixed. The debt register is frozen: a human closes those entries after the merge.
