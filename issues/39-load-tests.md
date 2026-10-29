# 39: Load tests (k6)

**What to build:** capacity and durability claims are backed by repeatable load tests and recorded results. Spec: Load tests; ADR 0004.

**Blocked by:** 31, 12

**Status:** ready-for-agent

- [ ] Queue storm: 5k virtual users join one event → admissions never exceed `admitRate`, no 5xx, refresh keeps the position.
- [ ] Hot seat: 500 virtual users on 10 seats → zero oversell in the database; report the `SEAT_UNAVAILABLE`/`BOOKING_BUSY` split, throughput and p95/p99.
- [ ] Durability cost: run the hot-seat scenario with NATS `sync_interval` at the default and at `always`, and record relay publish p50/p99 and throughput.
- [ ] Runs locally against Docker Compose; commands and results are recorded in the docs.
