# 12: Lock timeout and deadlock retry

**What to build:** under heavy contention a booking request never hangs or fails with an internal error: blocked transactions time out and retry, and if retries are exhausted the buyer gets a retryable `BOOKING_BUSY`. Spec: Holding seats (step 3); ADR 0005. Owns TD-020 (MEDIUM), TD-067, TD-071, TD-016 and TD-018 in `docs/technical-debt.md`: locking, retry, timeout and transaction-correctness guarantees the retry relies on.

**Previous attempt:** run 20261106-132615 was rejected after three review rounds (branch `rejected/12-lock-timeout-and-deadlock-retry-20261106-132615`, logs `.ralph/logs/20261106-132615/`). It may be read as reference material only; its code and its reviews count for nothing here. The criteria below name every gap its reviews found. Guarantees that depend on Postgres behaviour are proved against the real test database (ADR 0010), never against a hand-built error object or a proxied client.

**Blocked by:** 10

**Status:** ready-for-agent

Timeouts and the transaction budget

- [ ] Booking transactions (`holdSeats` and `placeOrder`) run with `lock_timeout` 3s and `statement_timeout` 5s, local to the transaction. A test reads `current_setting('lock_timeout')` and `current_setting('statement_timeout')` from inside a transaction the service itself opens with its default options (for example through a test trigger or a narrow seam that runs a query in that transaction), and asserts `3s` and `5s`; a session outside the booking transaction is unaffected. The service may accept shorter timeouts as an option for other tests, but this test pins the production defaults.
- [ ] The Prisma interactive-transaction `timeout` and `maxWait` that the production clients use (`apps/web/src/server/trpc.ts` and any other caller of the booking service) are set explicitly and documented against the worst single attempt (buyer advisory lock wait plus seat lock wait plus statements). A test using exactly those client options runs a booking transaction that waits on two locks in turn and ends in the lock-timeout retry and finally `BOOKING_BUSY`, never a raw `P2028`.

Retry

- [ ] `40P01`, `55P03` and `40001` retry the whole transaction up to 3 times; each retry increments `deadlock_retry`.
- [ ] `55P03`: a transaction blocked past `lock_timeout` is retried 3 times and then returns `BOOKING_BUSY`, for `holdSeats` and for `placeOrder`, and each test asserts `deadlock_retry` = 3 and `booking_busy` = 1.
- [ ] `40P01`: an induced deadlock is retried and the whole transaction then succeeds, leaving exactly one committed hold or order (AT-05). The test is deterministic about which side Postgres aborts, or asserts the outcome of whichever side was aborted.
- [ ] `40001`: Postgres raises a real serialization failure inside the service's own transaction on its first attempt only, through the real driver and Prisma (booking runs under READ COMMITTED, so a test-scoped trigger `RAISE ... USING ERRCODE = '40001'` is acceptable; a hand-built error object is not). The whole transaction is retried and succeeds, the first attempt left no rows, and `deadlock_retry` = 1. The trigger is scoped to the test's own rows and removed afterwards.
- [ ] Retry jitter comes from an injected random source and the wait from an injected timer seam. With a fixed random source, a test asserts the exact delay before each retry; with different random values the delays differ; with the default sources the delays stay inside the documented bounds.
- [ ] Error classification reads only the error fields the real driver and Prisma were observed to produce; each recognised shape is covered by one of the real-Postgres tests above.

Saturation and timeouts that are not retried

- [ ] A pool acquire timeout returns `BOOKING_BUSY` (tRPC `TOO_MANY_REQUESTS`) and counts `booking_busy`, for `holdSeats` and for `placeOrder`, including a `placeOrder` that fails before its hold or event has been read. Both the service tests and the router tests (`apps/web/src/server/routers/booking.test.ts`) assert the error code and the `booking_busy` count; `docs/database/index.md` names the key the count goes to when the event is not yet known.
- [ ] TD-067: pool saturation is recognised by a test against the real driver (the message it matches is pinned, and the coupling is noted next to it). A `P2028` raised because a transaction exceeded its own runtime timeout is not `BOOKING_BUSY` (test), and a `P2028` raised because the transaction was already closed is not `BOOKING_BUSY` either (separate test).
- [ ] SQLSTATE `57014`: a statement cancelled by `statement_timeout` (real Postgres, for example a test-scoped trigger that runs `pg_sleep` past the timeout) returns `BOOKING_BUSY` without a retry and counts `booking_busy`. A statement cancelled for any other reason (for example `pg_cancel_backend` from another session) is not `BOOKING_BUSY` and surfaces as an internal error with its cause. Both are tests; the message or field that tells them apart is pinned and the coupling is noted next to it.

Correctness the retry relies on

- [ ] TD-018: a failure after the writes have begun (for example a failing outbox insert) leaves no hold, no claim and the seat `AVAILABLE`, both for a first attempt and for an attempt that is itself a retry.
- [ ] TD-016: the clock-after-lock test synchronises on Postgres (`pg_locks` / `pg_blocking_pids`) instead of sleeps. Every clock read the service makes after its lock-free snapshot is stamped synchronously with a flag that the blocker sets only after its `COMMIT` has returned, and the test asserts every such read carries it (not only the last one). The TD-016 `Resolution` describes the mechanism the test really uses.

Test synchronisation

- [ ] TD-071: the saturation tests in `packages/booking/src/hold-busy.test.ts` and `apps/web/src/server/routers/booking.test.ts` wait for a signal from inside the occupying transaction instead of a fixed sleep.
- [ ] No test in this ticket holds a lock or a connection for a fixed time: blockers are released by a latch the test opens once the service call has settled (no fixed multi-second sleeps such as the previous attempt's 16s). Every wait on Postgres state (for example polling `pg_stat_activity` until a backend is blocked) has a deadline that fails with a message naming what it waited for, and is raced against the call under test so an early rejection surfaces.
- [ ] Shared test synchronisation helpers (`occupy`, latches, blocked-backend polling) exist once, in a file whose name marks it test-only and which `packages/booking/src/index.ts` does not export; tests do not share mutable clients across test cases. (`packages/test-infra/` is protected and out of scope.)

Production wiring

- [ ] The web app's tRPC context supplies a real `BookingMetrics` in production: `createRedisBookingMetrics` over an Upstash REST client built from `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`, validated at the boundary (a `parseServerEnv`-style function naming the offending field) and injected, never read inside packages. It adds no new dependency (a `fetch`-based `HINCRBY` call is enough). Tests prove the context passes the metrics through to the booking procedures and that the adapter sends `HINCRBY` with the bearer token (the HTTP boundary may be faked); a metrics failure never fails a booking.

Debt

- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 12 (TD-016, TD-018, TD-020, TD-067, TD-071) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
