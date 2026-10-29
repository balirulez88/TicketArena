# 10: Hot-seat race, snapshot fast path and booking metrics

**What to build:** when many buyers try to hold the same seat at once, exactly one wins and the rest are refused cleanly; refusals for visibly taken seats return immediately without taking locks, and counters separate ordinary refusals from lost races. Spec: Holding seats (steps 1, 2.5, 4); ADR 0005.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] A lock-free snapshot read returns `SEAT_UNAVAILABLE` for visibly `SOLD`, `IN_CHECKOUT` or unexpired `HELD` seats without locking.
- [ ] Metrics port with a Redis adapter: `hold_ok`, `seat_unavailable`, `race_lost` per event, incremented after commit, fire-and-forget; a Redis failure is logged and never fails a booking.
- [ ] AT-01: 100 concurrent holds on one free seat → exactly 1 success; all others `SEAT_UNAVAILABLE` or `BOOKING_BUSY`; zero other errors; one live hold in the database. With the test's pool and timeouts sized for it, 99 `SEAT_UNAVAILABLE` is asserted and the split is reported.
- [ ] AT-06: a hold on a sold seat returns without waiting on a lock held by another transaction; `seat_unavailable` and `race_lost` are counted correctly.
