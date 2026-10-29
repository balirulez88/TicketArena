# 0010: Integration tests on real infrastructure, behind ports with contract tests

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

The core guarantees (no oversell, lock ordering, expiry races, redelivery, DLQ routing) depend on
the actual behaviour of Postgres locks, Redis Lua atomicity and JetStream acknowledgements. Mocks
cannot prove them; PGlite is single-connection and cannot run a lock race. Production uses Neon
(serverless driver) and Upstash (REST), which do not run locally.

## Decision

- Integration tests run against **real Postgres 17, Redis 7 and nats-server**.
- `pnpm test` runs unit **and** integration tests as one gate. Integration tests require
  `TEST_DATABASE_URL`, `TEST_REDIS_URL` and `TEST_NATS_URL`; a missing variable **fails** the run
  (skipped tests are banned by the quality gate).
- Isolation: each test file gets its own database cloned from a migrated template, plus its own
  Redis key prefix and JetStream stream prefix, so files run in parallel.
- Provisioning: the Ralph sandbox image installs and starts the three services; CI uses GitHub
  Actions service containers; developers use Docker Compose.
- Infrastructure differences live behind ports:
  - Prisma client factory takes an injected driver adapter (`adapter-pg` for local, tests and the
    worker; `adapter-neon` for Vercel).
  - `QueueStore` has a node-redis adapter and an Upstash adapter; one shared contract suite runs
    against both.
  - `MessageBus` has the JetStream adapter and its contract suite.
- Correctness tests and load tests are separate: correctness tests assert invariants in the gate;
  k6 measures throughput, latency and timeouts outside the gate.

## Alternatives considered

- **Mocks / in-memory fakes:** cannot exhibit lock waits, deadlocks or redelivery.
- **Testcontainers:** needs Docker inside the sandbox, which we do not have.
- **Tests against Neon branches:** slow, rate-limited, and network-dependent.

## Consequences

- The sandbox image and CI are heavier; every slice is judged on real infrastructure.
- The Upstash adapter is verified by the shared contract suite in CI against an Upstash-compatible
  endpoint, not only in production.
