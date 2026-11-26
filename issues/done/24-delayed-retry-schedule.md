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
