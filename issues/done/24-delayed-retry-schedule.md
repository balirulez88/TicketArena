# 24: Delayed retry schedule

**What to build:** a consumer that hits a transient error retries the message later with increasing delays, never immediately and never not at all. Spec: Messaging (consumer runner); ADR 0011.

**Blocked by:** 06, 45 (worker loop error reporting)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** retry, DLQ and recovery after the MVP (2026-11-18)

- [x] The runner maps a transient handler failure to `nak(delay)` with delays 1s, 5s, 30s, 2m by `deliveryCount`; no consumer `BackOff`.
- [x] `deliveryCount` is the only attempt counter.
- [x] Long handlers can call `working()`.
- [x] AT-27: a transient failure is redelivered after the scheduled delay and succeeds on a later attempt.

## Fifth and later deliveries (Q8)

Checked, already met: until the DLQ gate lands, the fifth and every later failed delivery keeps the two-minute delay. `RETRY_DELAYS_MS` in `packages/messaging/src/consumer-runner.ts` is 1 s, 5 s, 30 s, 2 min, and its last entry repeats past the fourth delivery; the runner never ends retries itself. Ticket 25 adds the `deliveryCount > 5` DLQ gate, which runs before the handler (ADR 0011). Test: `packages/messaging/src/consumer-runner-retry.test.ts` :: "naks a transient handler failure with 1s, 5s, 30s, 2m by deliveryCount and keeps 2m after that" (deliveries 4, 5 and 6 are all `nak`ed with 120 000 ms).
