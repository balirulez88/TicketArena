# 01: Real-infrastructure test harness and CI

**What to build:** every later slice can run integration tests against real Postgres 17, Redis 7 and NATS JetStream: locally via Docker Compose, inside the Ralph sandbox, and in GitHub Actions. The Prisma client factory accepts an injected driver adapter so tests and the worker use `adapter-pg` while Vercel uses `adapter-neon`. CI runs the full gate on every push and pull request from this ticket onward. Spec: Testing Decisions; ADR 0010, ADR 0013.

> Interactive ticket: completed in a supervised session, not by `ralph-loop.sh` (the loop cannot rebuild its own sandbox image). Its status is `in-progress` so the harness skips it; set it to `done` once verified.

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-10-29 by hand, before the harness (e133126)

- [x] Docker Compose provides Postgres 17, Redis 7 and NATS with JetStream enabled (`sync_interval: always`).
- [x] The sandbox image installs Postgres, Redis and nats-server; the entrypoint starts them and exports `TEST_DATABASE_URL`, `TEST_REDIS_URL`, `TEST_NATS_URL`.
- [x] Integration tests fail loudly (never skip) when any `TEST_*` variable is missing.
- [x] Each test file gets an isolated database cloned from a migrated template, its own Redis key prefix and its own JetStream stream prefix; files run in parallel.
- [x] The Prisma client factory takes an injected adapter; the package still never reads `process.env`.
- [x] One smoke integration test per service (Postgres, Redis, NATS) passes under `pnpm test`.
- [x] A GitHub Actions workflow runs `pnpm check` with Postgres, Redis and NATS from `docker-compose.yml` (GitHub `services:` cannot pass NATS its config); it is green on `main`.
- [x] The Ralph sandbox runs `pnpm run check` green against its own services.
- [x] `docs/workflow` and `docs/database` describe the harness, isolation and adapters.
