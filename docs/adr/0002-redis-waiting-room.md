# 0002: Waiting room queue in Upstash Redis

- **Status:** Accepted (admission policy details open, see system map)
- **Date:** 2026-10-28

## Context

At on-sale, request volume exceeds what checkout and Postgres can serve. Excess demand must wait
somewhere cheap, ordered, and fast, without touching the transactional database.

## Decision

Queue state (membership, ordering, admission tokens) lives in **Upstash Redis**, accessed over
its HTTP REST API so serverless functions need no persistent connections. Postgres is reached
only by admitted buyers.

## Alternatives considered

- **Queue in Postgres:** puts the spike on the one resource we are trying to protect.
- **Self-hosted Redis / managed queue (SQS):** connection management from serverless, extra
  ops; SQS does not expose queue position to users.
- **CDN-level waiting room (vendor product):** less to build, but hides the core engineering
  problem this project exists to demonstrate.

## Consequences

- Sorted sets and atomic scripts give O(log n) enqueue and position lookups.
- REST-only access rules out long-lived pub/sub, so position updates are pull-based or relayed.
- Redis is not the source of truth for sales: losing it degrades fairness, never correctness.
