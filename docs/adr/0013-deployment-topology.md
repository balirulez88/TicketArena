# 0013: Deployment topology and CI

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

The web app is serverless; the relay, consumers, sweeper, reconciler and admission ticker are
long-running. Reviewers should be able to click a live demo, and every slice must be verified
automatically from the first one onwards.

## Decision

- **Web:** Vercel (Next.js 16), Neon pooled connection via `adapter-neon`.
- **Database:** Neon Postgres. Migrations run with `prisma migrate deploy` in CI on the direct
  connection before the web deploy.
- **Redis:** Upstash (REST adapter in web and worker).
- **Worker + NATS:** Fly.io. One worker app (relay, payment, notification, sweeper, reconciler,
  admission ticker modules, `/health`). NATS with JetStream on a Fly volume, reached over private
  networking.
- **Local:** Docker Compose (Postgres 17, Redis 7, NATS).
- **CI:** GitHub Actions from the first slice: `pnpm check` with Postgres, Redis and NATS service
  containers; required on `main`.

## Alternatives considered

- **Three separately deployed services:** triples operations for no demo benefit; module
  boundaries keep extraction cheap.
- **Local-only:** no live demo for reviewers.
- **Hosted NATS (Synadia Cloud):** viable; self-hosting next to the worker keeps latency and cost
  predictable and lets us set `sync_interval`.

## Consequences

- Single-node NATS and a single worker are single points of failure for async processing (not for
  seat correctness); the outbox absorbs outages.
- Load tests run locally (k6 against Compose), because free tiers would rate-limit them.
