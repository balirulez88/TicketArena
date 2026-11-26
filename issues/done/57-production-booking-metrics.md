# 57: Production booking metrics

**What to build:** the running web app counts booking outcomes in Upstash Redis: `hold_ok`, `booking_busy` and `deadlock_retry` (and the existing refusal counters) reach the per-event hash for both `holdSeats` and `placeOrder`, best-effort, without ever failing a booking. Spec: Holding seats (steps 3–4), Admin dashboard (story 39); ADR 0005. Split from ticket 12 (part 4 of 4, see `issues/12-lock-timeout-and-deadlock-retry.md`). Owns TD-070 in `docs/technical-debt.md`.

**Blocked by:** 54, 55, 56

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

Each criterion names its test and the sabotage that test must catch. Tests use the helpers and client rules ticket 55 established (`@ticketarena/booking/testing`).

- [x] Ground rules: guarantees that depend on Postgres are proved against the real test database (ADR 0010); the Upstash HTTP boundary may be a local fake HTTP server. No existing assertion is removed or loosened. No new dependency.
- [x] Wiring: the booking procedures (`holdSeats`, `placeOrder`) get their `BookingMetrics` from the context's metrics dependency (ticket 56): `createRedisBookingMetrics` over the Upstash client. Procedures that do not book never resolve it. Test: the context hands the same metrics instance to both procedures. Sabotage: constructing the service without metrics turns the integration tests below red.
- [x] `holdSeats` end to end: through the router (`createCaller` with the real context factory pointed at the test database and a fake Upstash server), a successful hold sends `HINCRBY booking:metrics:<eventId> hold_ok 1`; a hold that exhausts lock-timeout retries returns `BOOKING_BUSY` and sends `deadlock_retry` three times and `booking_busy` once; a hold refused on a saturated pool sends `booking_busy` once. Each test asserts the exact commands the fake server received.
- [x] `placeOrder` end to end: through the router, an order whose transaction is retried once after a real `40001` (test-scoped trigger) succeeds and sends `deadlock_retry` once; an order refused on a saturated pool before its event is known sends `booking_busy` to the unknown-event key ticket 54 documented. Each test asserts the exact commands.
- [x] Best effort: with the fake server returning 500, never answering (request timeout) or refusing the connection, `holdSeats` and `placeOrder` still succeed with their normal result, and the failure is logged once per increment with the metric name. Sabotage: awaiting the increment inside the booking result path makes the never-answering case exceed its test timeout.
- [x] TD-070: no production caller builds the booking service without metrics: the Wiring and end-to-end tests above prove the counters reach Upstash from the app, and `docs/index.md` no longer claims more than the code does. Sabotage: as for Wiring.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 57 (TD-070) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).

**Documentation deliverable (reviewed, not test-verified):** `docs/database/index.md` states that production counts go to Upstash through the context, which counters each operation sends, and that they are best-effort (a request cut short by the platform may lose an increment).
