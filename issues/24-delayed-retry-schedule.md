# 24: Delayed retry schedule

**What to build:** a consumer that hits a transient error retries the message later with increasing delays, never immediately and never not at all. Spec: Messaging (consumer runner); ADR 0011.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] The runner maps a transient handler failure to `nak(delay)` with delays 1s, 5s, 30s, 2m by `deliveryCount`; no consumer `BackOff`.
- [ ] `deliveryCount` is the only attempt counter.
- [ ] Long handlers can call `working()`.
- [ ] AT-27: a transient failure is redelivered after the scheduled delay and succeeds on a later attempt.
