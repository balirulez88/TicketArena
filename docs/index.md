# TicketArena: System Map

> Root of the architectural memory. Agents read this first; `skills/update-docs.md` keeps it
> current after every green slice. It describes the system **as it is today** plus the decisions
> still open.

## What the system does

TicketArena sells tickets for high-demand events. When an on-sale opens, demand can exceed
capacity by orders of magnitude within seconds. The system must:

1. **Absorb the spike** without the booking path or database falling over.
2. **Be fair**: admit buyers to checkout in a defensible order, not "whoever retries fastest".
3. **Never oversell**: a seat is sold at most once, even under concurrent attempts.
4. **Stay consistent across services**: payments and notifications happen exactly when a
   booking really committed, never for a rolled-back one.

## Architecture at a glance

```text
                 ┌───────────────────────── apps/web (Next.js App Router) ─────────────────────────┐
 Browser ──────► │  UI (React, Tailwind v4, shadcn/ui, Zustand)                                     │
  (tRPC client)  │  tRPC API ──► Waiting Room ──► Upstash Redis  (queue, admission tokens)         │
                 │           └─► Booking ──────► Neon Postgres (Prisma)                             │
                 │                                 └─ same TX ─► outbox_events                      │
                 └──────────────────────────────────────────────────────────────────────────────────┘
                                                    │ relay polls PENDING rows
                                                    ▼
                                     Message broker (Kafka or NATS: open)
                                          │                         │
                                          ▼                         ▼
                                  Payment service           Notification service
```

| Area                | Status      | Map                                    |
| ------------------- | ----------- | -------------------------------------- |
| Monorepo & modules  | scaffolded  | [architecture/](architecture/index.md) |
| Database & Prisma   | outbox only | [database/](database/index.md)         |
| Async messaging     | designed    | [messaging/](messaging/index.md)       |
| Agent workflow & CI | operational | [workflow/](workflow/index.md)         |
| Decisions (ADRs)    | 3 accepted  | [adr/](adr/index.md)                   |
| Feature specs       | none yet    | [specs/](specs/index.md)               |
| Domain vocabulary   | seeded      | [glossary.md](glossary.md)             |

## What exists today

- Turborepo + pnpm monorepo: `apps/web`, `packages/db`.
- `apps/web`: Next.js App Router with an end-to-end tRPC tracer (`health.check`), validated
  server env (`parseServerEnv`), shadcn/ui tokens on Tailwind v4.
- `packages/db`: Prisma 7 on the Neon serverless adapter; the `outbox_events` table.
- Quality gate: Biome (warnings fail), strict `tsc`, Vitest, enforced by `ralph-loop.sh`.

No domain features yet. They arrive as tickets produced by `/grill-me` → `/to-spec` → `/to-tickets`.

## Open decisions (input for `/grill-me`)

1. **Broker:** Kafka (log retention, replay, partitions) vs NATS JetStream (lighter ops, subjects).
2. **Outbox relay hosting:** a long-running worker app vs scheduled polling vs Postgres logical
   replication (CDC). Serverless Next.js cannot host a long-lived poller.
3. **Waiting-room admission:** strict FIFO vs a randomised pre-queue for buyers who arrive before
   the on-sale; admission rate (fixed tokens/sec vs adaptive to checkout capacity).
4. **Queue position delivery:** client polling vs SSE. Upstash's REST API offers no long-lived
   pub/sub connection, which constrains push.
5. **Seat holds:** Redis TTL locks vs Postgres rows with `expires_at` and `SKIP LOCKED`;
   hold duration; behaviour when a hold expires mid-payment.
6. **Overselling guarantee:** which store is the source of truth for seat state, and where the
   uniqueness constraint lives.
7. **Payments:** real provider sandbox vs simulated payment service; idempotency key design.
8. **Identity:** auth provider, guest checkout, per-account ticket limits, bot mitigation.
9. **Deployment & load testing:** Vercel + Neon + Upstash, worker host, and how we prove
   capacity (e.g. k6 scenarios).
