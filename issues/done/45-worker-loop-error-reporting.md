# 45: Worker loop error reporting

**What to build:** when the outbox relay or a consumer runner fails (database or broker outage, a broken claim query, a handler that keeps throwing), an operator can see it: every failure is logged with its cause, never swallowed. Resolves TD-031 and TD-032 in `docs/technical-debt.md`; must merge before ticket 24, which changes the same failure path and is blocked by it.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [x] TD-031: a relay tick that fails outside a single row's publish (claim query, status update or commit fails, e.g. the database is unreachable) is logged at `error` with the cause, and the relay keeps running and publishes once the outage ends (test with a real outage or a failing injected store).
- [x] TD-031: a sustained outage is not logged on every 250 ms tick: repeated identical failures are rate-limited, and the first success after them is logged (test with a controlled clock).
- [x] TD-032: a consumer runner whose fetch fails (broker unreachable) logs the cause at `error` and keeps polling (test).
- [x] TD-032: a handler failure is logged with the error and the delivery count before the `nak`, proved by a test (the poison-message loop itself is ticket 25's DLQ gate; the entry names it).
- [x] TD-031: failures are rate-limited per cause, also when causes alternate (review follow-up, Q7): the first occurrence of each cause is logged at `error`, each cause repeats at most once per 60 s, the per-cause map is bounded (32 causes, least recently logged evicted first), and one recovery line carries the failure count and the outage duration (`packages/messaging/src/failure-reporter.test.ts`).
- [x] ~~The register entries TD-031 and TD-032 are `RESOLVED` with the verifying tests named in `Verification`.~~ Superseded by [ADR 0024](../../docs/adr/0024-frozen-debt-register-check.md) (Q6): `docs/technical-debt.md` is frozen and never edited; the evidence is recorded below instead. The poison-message DLQ gate belongs to ticket 25.

## Evidence (ADR 0024: TD-031, TD-032)

TD-031 (relay loop):

- `packages/messaging/src/outbox-relay-logging.test.ts` :: "logs a tick that fails outside a row's publish at error with the cause, keeps running and publishes once the outage ends (TD-031)"
- `packages/messaging/src/outbox-relay-logging.test.ts` :: "rate-limits identical failures during a sustained outage and logs the first success after them (TD-031)"
- `packages/messaging/src/failure-reporter.test.ts` :: "rate-limits each cause in its own window when causes alternate, then logs one recovery line"
- `packages/messaging/src/failure-reporter.test.ts` :: "keeps the per-cause window bounded, forgetting the least recently logged cause first"

TD-032 (consumer runner):

- `packages/messaging/src/consumer-runner-logging.test.ts` :: "logs a failed fetch at error with the cause and keeps polling (TD-032)"
- `packages/messaging/src/consumer-runner-logging.test.ts` :: "logs a handler failure at error with the error and the delivery count before the nak (TD-032)"

The consumer poll loop uses the same failure reporter, so the per-cause rate limit and the recovery line apply to `consumer poll failed` / `consumer poll recovered` as well.
