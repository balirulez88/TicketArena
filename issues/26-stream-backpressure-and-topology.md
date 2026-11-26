# 26: Stream backpressure and topology hardening

**What to build:** a full stream never drops events: publishes are rejected and the events wait in the outbox. Topology can be re-applied safely at any time. Spec: Messaging; ADR 0004. Owns TD-036 in `docs/technical-debt.md`.

**Blocked by:** 06

**Status:** ready-for-agent

**Status reason:** after the MVP (scope cut 2026-11-18)

- [ ] AT-35: `ensureTopology()` is idempotent and updates config in place; the two streams' subjects do not overlap; with `max_bytes` exceeded, publishes are rejected and outbox rows stay `PENDING` until space frees.
- [ ] Outbox lag (age of the oldest `PENDING` row) is computable for the dashboard.
- [ ] TD-036: `ensureTopology()` falls back to updating a stream only when adding it fails because the stream already exists; any other `add` failure (for example invalid configuration, or the broker unreachable) propagates with its original cause, and no update is attempted (tests against real NATS for both). Sabotage: restoring the bare `catch {}` around the add turns the second test red.
- [ ] The delivery guarantee and its bounds (7-day `max_age`, single-node disk loss) are documented in `docs/messaging`.
- [ ] Every entry in `docs/technical-debt.md` whose Target is ticket 26 (TD-036) is `RESOLVED`, with the tests that prove it named in `Verification` (the host refuses the merge otherwise).
