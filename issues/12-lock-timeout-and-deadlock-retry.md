# 12: Lock timeout and deadlock retry

**What to build:** under heavy contention a booking request never hangs or fails with an internal error: blocked transactions time out and retry, and if retries are exhausted the buyer gets a retryable `BOOKING_BUSY`. Spec: Holding seats (step 3); ADR 0005.

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] Booking transactions set `lock_timeout` 3s and `statement_timeout` 5s.
- [ ] `40P01`, `55P03` and `40001` retry the whole transaction up to 3 times with jitter; each retry increments `deadlock_retry`.
- [ ] Exhausted retries and pool acquire timeouts return `BOOKING_BUSY` (tRPC `TOO_MANY_REQUESTS`), counted as `booking_busy`.
- [ ] AT-05: a transaction blocked past `lock_timeout` is retried and finally returns `BOOKING_BUSY`; an induced deadlock is retried and succeeds.
