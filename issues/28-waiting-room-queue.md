# 28: Waiting-room queue (join, status, leave)

**What to build:** a buyer can join an event's waiting room, see their position and estimated wait, keep their position on refresh, and leave. Buyers who joined before the on-sale are ordered fairly at random, ahead of later arrivals. Spec: Waiting room; ADR 0008.

**Blocked by:** 02, 03

**Status:** ready-for-agent

- [ ] The `waiting-room` package defines the `QueueStore` port and a node-redis adapter; all mutations are atomic Lua scripts; keys carry a configurable prefix.
- [ ] A join before `onSaleAt` scores a random value in `[0, 1)` from the injected `Random`; later joins score `1 + sequence`; `ZADD NX`.
- [ ] `AdmissionPolicy.isQueueActive` reads the event schedule; outside the window, `join` reports immediate admission eligibility.
- [ ] `queue.join`, `queue.status` (position, ETA) and `queue.leave` via tRPC.
- [ ] AT-36: pre-queue joins are all ahead of later joins and ordered by the injected randomness; later joins are FIFO.
- [ ] AT-37: re-joining keeps the position.
- [ ] `docs/architecture` gains a waiting-room page (keys, scripts, invariants).
