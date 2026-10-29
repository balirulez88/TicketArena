# 11: Multi-seat holds and the buyer limit

**What to build:** a buyer can hold up to 6 seats in one all-or-nothing action, and can never exceed 6 live seats per event, even with concurrent requests, counting held, in-checkout and sold seats exactly once. Spec: Holding seats (steps 2.1–2.7); ADR 0005.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] `holdSeats` accepts 1–6 seat ids of one event (zod-validated).
- [ ] Global lock order: `pg_advisory_xact_lock(hash(eventId:buyerKey))`, then seats `ORDER BY id FOR UPDATE`; `placeOrder` takes the same buyer lock first.
- [ ] Usage counts seats with `claimBuyerKey = buyerKey` that are `HELD` (unexpired at `T`), `IN_CHECKOUT` or `SOLD`; over 6 → `LIMIT_EXCEEDED`, counted as `limit_exceeded`.
- [ ] AT-02: overlapping multi-seat requests never leave a partial hold.
- [ ] AT-03: two parallel 4-seat holds by one buyer on disjoint seats → one success, one `LIMIT_EXCEEDED`.
- [ ] AT-04 (first part): hold 4 → `placeOrder` → usage still 4; a further 3-seat hold → `LIMIT_EXCEEDED`.
