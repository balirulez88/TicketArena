# 26: Stream backpressure and topology hardening

**What to build:** a full stream never drops events: publishes are rejected and the events wait in the outbox. Topology can be re-applied safely at any time. Spec: Messaging; ADR 0004.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] AT-35: `ensureTopology()` is idempotent and updates config in place; the two streams' subjects do not overlap; with `max_bytes` exceeded, publishes are rejected and outbox rows stay `PENDING` until space frees.
- [ ] Outbox lag (age of the oldest `PENDING` row) is computable for the dashboard.
- [ ] The delivery guarantee and its bounds (7-day `max_age`, single-node disk loss) are documented in `docs/messaging`.
