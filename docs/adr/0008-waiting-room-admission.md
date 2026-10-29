# 0008: Waiting-room ordering, admission rate and admission tokens

- **Status:** Accepted (refines [ADR 0002](0002-redis-waiting-room.md))
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

ADR 0002 put queue state in Redis but left the admission policy open. Buyers who arrive early
must not gain an advantage by refreshing; the booking path must see a bounded, steady flow; and
the queue must be enforced by the backend, not by the UI.

## Decision

- **Schedule:** each event has `onSaleAt` and a queue window. An `AdmissionPolicy` port decides
  whether a queue is active; the MVP implementation reads the schedule. Load-based activation is a
  later implementation of the same port. `holdSeats` always requires admission; outside the queue
  window the policy admits immediately.
- **Order:** one Redis ZSET per event. Buyers joining before `onSaleAt` get a random score below
  every post-on-sale score (an injected `Random`), which is equivalent to shuffling the pre-queue
  at `onSaleAt`; later joiners get increasing scores (FIFO). `ZADD NX` makes refresh keep the spot.
- **Rate:** a token bucket per event refilled at `admitRate`/s, plus a hard `maxActive` cap on
  admitted shoppers. A worker ticker admits from the head while both allow.
- **Active slots:** a ZSET scored by `lastSeenAt`, refreshed by admitted calls and status polls.
  A slot frees on order placed, explicit leave, or reaping (90s idle or expired admission). Freeing
  a slot revokes its admission.
- **All queue operations are atomic Lua scripts** (join, admit, heartbeat, release, reap).
- **Admission token:** a JWT (HS256, `ADMISSION_SECRET`) with `sub = sessionId`, `eid = eventId`,
  `jti`, `exp` = 30 minutes fixed, in an httpOnly per-event cookie. `admittedProcedure` checks the
  signature, `exp`, `sub` against the current session, `eid` against the requested event, and the
  `jti` against the Redis admitted set (revocation).
- **Scope:** admission gates **only `holdSeats`**. `placeOrder` and actions on things the buyer
  already owns are authorized by ownership of a valid hold or order, so admission expiry never
  breaks a hold or a payment in progress.
- Clients poll `queue.status` every 3s.

## Alternatives considered

- **Strict FIFO from first arrival:** rewards early refreshers and bots.
- **Admission decided on the client's poll:** a vanished head-of-queue blocks everyone behind it.
- **Admission gating `placeOrder` too:** a 30-minute token could expire mid-checkout.
- **SSE / push for position:** Upstash REST has no long-lived pub/sub; serverless functions are a
  poor host for long connections.

## Consequences

- Redis loss degrades fairness, never correctness (seat state is in Postgres, ADR 0005).
- Guest identity is a cookie, so a buyer can rejoin as a new session; bot mitigation is phase 2.
