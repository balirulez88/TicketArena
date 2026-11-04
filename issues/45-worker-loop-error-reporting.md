# 45: Worker loop error reporting

**What to build:** when the outbox relay or a consumer runner fails (database or broker outage, a broken claim query, a handler that keeps throwing), an operator can see it: every failure is logged with its cause, never swallowed. Resolves TD-031 and TD-032 in `docs/technical-debt.md`; must merge before ticket 24, which changes the same failure path and is blocked by it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-031: a relay tick that fails outside a single row's publish (claim query, status update or commit fails, e.g. the database is unreachable) is logged at `error` with the cause, and the relay keeps running and publishes once the outage ends (test with a real outage or a failing injected store).
- [ ] TD-031: a sustained outage is not logged on every 250 ms tick: repeated identical failures are rate-limited, and the first success after them is logged (test with a controlled clock).
- [ ] TD-032: a consumer runner whose fetch fails (broker unreachable) logs the cause at `error` and keeps polling (test).
- [ ] TD-032: a handler failure is logged with the error and the delivery count before the `nak`, proved by a test (the poison-message loop itself is ticket 25's DLQ gate; the entry names it).
- [ ] The register entries TD-031 and TD-032 are `RESOLVED` with the verifying tests named in `Verification`, or TD-032 stays `PLANNED` for ticket 25 if only its logging part is fixed here, with that split recorded in its history.
