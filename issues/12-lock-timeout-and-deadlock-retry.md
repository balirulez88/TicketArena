# 12: Lock timeout and deadlock retry

**What to build:** under heavy contention a booking request never hangs or fails with an internal error: blocked transactions time out and retry, and if retries are exhausted the buyer gets a retryable `BOOKING_BUSY`. Spec: Holding seats (step 3); ADR 0005. Owns TD-020 (MEDIUM), TD-067, TD-071, TD-016 and TD-018 in `docs/technical-debt.md`: locking, retry, timeout and transaction-correctness guarantees the retry relies on.

**Blocked by:** 10

**Status:** in-progress

- [x] Booking transactions set `lock_timeout` 3s and `statement_timeout` 5s.
- [x] `40P01`, `55P03` and `40001` retry the whole transaction up to 3 times with jitter; each retry increments `deadlock_retry`.
- [x] Exhausted retries and pool acquire timeouts return `BOOKING_BUSY` (tRPC `TOO_MANY_REQUESTS`), counted as `booking_busy`.
- [x] AT-05: a transaction blocked past `lock_timeout` is retried and finally returns `BOOKING_BUSY`; an induced deadlock is retried and succeeds.
- [x] TD-020: `holdSeats` and `placeOrder` both run under these timeouts and this retry, and the router maps `BOOKING_BUSY` for both (tests for each).
- [x] TD-067: pool saturation is recognised by a test against the real driver (the message it matches is pinned, and the coupling is noted next to it); a `P2028` raised because a transaction exceeded its own runtime timeout, or was already closed, is not reported as a retryable `BOOKING_BUSY` (test).
- [x] TD-071: the saturation tests in `hold-busy.test.ts` and `apps/web/src/server/routers/booking.test.ts` wait for a signal from inside the occupying transaction instead of a fixed sleep.
- [x] TD-016: the clock-after-lock test synchronises on Postgres (`pg_locks` / `pg_blocking_pids`) instead of sleeps, and records the clock read against a flag set only after the blocker has committed.
- [x] TD-018: a failure after the writes have begun (for example a failing outbox insert) leaves no hold, no claim and the seat `AVAILABLE`, for a first attempt and for a retried one.
- [x] Every entry in `docs/technical-debt.md` whose Target is ticket 12 (TD-016, TD-018, TD-020, TD-067, TD-071) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
