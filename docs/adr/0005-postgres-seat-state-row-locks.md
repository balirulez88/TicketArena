# 0005: Seat state in Postgres with pessimistic row locks

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

Reserved seating means two buyers can target the same seat at the same instant. An oversell must
be impossible, not merely unlikely. Holds last minutes, but database transactions must last
milliseconds. A buyer may hold at most 6 seats per event, and two concurrent requests for disjoint
seats must not both pass that limit.

## Decision

**Postgres is the only source of truth for seat state.** Redis never decides whether a seat is free.

- A hold is an explicit row with an expiry. Seats carry `status` (`AVAILABLE`, `HELD`,
  `IN_CHECKOUT`, `SOLD`), the owning `holdId` and the claiming `buyerKey`.
- Every booking transaction acquires locks in one global order:
  **buyer advisory lock → hold row → order row → seat rows `ORDER BY id`**.
  - The buyer lock is `pg_advisory_xact_lock` on a hash of `eventId:buyerKey`. It serializes one
    buyer's requests for one event, so the limit count cannot race. A hash collision can only
    over-serialize two buyers, never admit one wrongly.
  - Seats are locked with `SELECT … FOR UPDATE`, waiting rather than `NOWAIT`. A waiter that
    would have reported "taken" while the holder rolls back is avoided.
- **Decision time is read after all locks are held**: `T = clock.now()` from the injected
  `Clock`, never SQL `now()` (pinned to transaction start) and never a value read before the lock
  wait. While the locks are held no one else can change the rows, so that instant is the
  linearization point.
- Lazy expiry: a `HELD` seat whose hold has `holdExpiresAt <= T` counts as free. `IN_CHECKOUT`
  seats are **never** freed lazily; only the order transition that ends checkout frees them.
- `lock_timeout` 3s and `statement_timeout` 5s per transaction. `40P01`, `55P03` and `40001` retry
  the whole transaction up to 3 times with jitter, then surface `BOOKING_BUSY`.
- A lock-free snapshot read precedes the locked step. If the snapshot already shows a seat taken,
  `holdSeats` returns `SEAT_UNAVAILABLE` without locking. The locked step alone decides success.

## Alternatives considered

- **Redis locks with TTL:** fast, but a second store deciding seat state reintroduces dual-write
  and clock problems; Redis failover can lose a lock.
- **Optimistic concurrency (version column / conditional `UPDATE`):** good at low contention,
  but under a hot-seat storm it turns into retry storms and cannot express the buyer limit.
- **`SERIALIZABLE` isolation:** correct, but serialization failures under hot contention make
  every loser retry; explicit locks give the same guarantee with predictable behaviour.
- **`clock_timestamp()` in SQL:** correct after locks, but not controllable from tests, and expiry
  races must be tested deterministically.

## Consequences

- One buyer's concurrent requests per event run one at a time (an intended throttle).
- Hot-seat storms queue on row locks; the snapshot fast path keeps most losers off the locks.
- Every booking write path must follow the lock order; deadlock retry is a safety net, not a plan.
- Clock skew between app instances only moves which side wins near a boundary, never lets both
  win, because the row lock serializes them and `placeOrder` re-checks seat ownership.
