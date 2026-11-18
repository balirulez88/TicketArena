# 30: Admission ticker and active slots

**What to build:** buyers are admitted from the head of the queue at a controlled rate, never beyond the active-shopper cap, and slots free reliably when a buyer finishes, leaves or goes idle. Spec: Waiting room; ADR 0008.

**Blocked by:** 28, 06

**Status:** done

**Completed:** 2026-11-18 on devflow/run-202611181233 (run 202611181233)

- [x] Admission ticker (worker, every 1s): token bucket at `admitRate`/s (burst `admitRate`) plus `maxActive`; admitted sessions enter the active ZSET.
- [x] Admitted calls and status polls heartbeat by updating `lastSeenAt`.
- [x] Reaper (worker, every 15s) frees slots idle for over 90s or with expired admission; `leave` and order placement also free the slot; freeing a slot removes its admission `jti`.
- [x] Queue length and active count are computable for the dashboard.
- [x] AT-38: admissions never exceed `admitRate` or `maxActive`.
- [x] AT-39: slots free on order placed, leave and reaping; freeing revokes admission.
