# 14: Hold expiry (lazy and sweeper)

**What to build:** an abandoned hold never blocks seats beyond 10 minutes: expired holds count as free when someone else tries to hold the seat, and a sweeper in the worker expires them every 15 seconds. Checkout and the sweeper can never both win. Spec: Expiry; ADR 0005.

**Blocked by:** 05, 07

**Status:** ready-for-agent

- [ ] `holdSeats` treats a `HELD` seat whose hold has `holdExpiresAt <= T` as free (`T` read after locks).
- [ ] Sweeper (worker, every 15s): `FOR UPDATE SKIP LOCKED` on `HELD` holds with `holdExpiresAt <= T`; hold → `EXPIRED`, its seats → `AVAILABLE`, outbox `hold.expired`.
- [ ] One `T` per transaction; a hold is valid iff `T < holdExpiresAt`, everywhere.
- [ ] AT-07: an expired hold's seat can be held by another buyer before the sweeper runs.
- [ ] AT-08: with the fake clock moved past `holdExpiresAt` while `placeOrder` waits on a lock held by the test → `HOLD_EXPIRED`.
- [ ] AT-09: `placeOrder` and the sweeper on the same hold, in both arrival orders → either an order (hold not expired) or `HOLD_EXPIRED` (seats freed), never both.
- [ ] AT-11: `placeOrder` refuses when a seat's `holdId` no longer matches its hold.
