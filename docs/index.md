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
                          apps/worker relay ──► NATS JetStream (MessageBus port)
                                          │                         │
                                          ▼                         ▼
                                  Payment service           Notification service
                                  (worker module)           (worker module)
```

The diagram shows the target of the [MVP spec](specs/ticketarena-mvp.md); "What exists today"
below shows what is built.

| Area                | Status      | Map                                    |
| ------------------- | ----------- | -------------------------------------- |
| Monorepo & modules  | scaffolded  | [architecture/](architecture/index.md) |
| Database & Prisma   | catalog     | [database/](database/index.md)         |
| Async messaging     | designed    | [messaging/](messaging/index.md)       |
| Agent workflow & CI | operational | [workflow/](workflow/index.md)         |
| Decisions (ADRs)    | 13 accepted | [adr/](adr/index.md)                   |
| Feature specs       | MVP ready   | [specs/](specs/index.md)               |
| Domain vocabulary   | seeded      | [glossary.md](glossary.md)             |

## What exists today

- Turborepo + pnpm monorepo: `apps/web`, `packages/db`.
- `apps/web`: Next.js App Router with an end-to-end tRPC tracer (`health.check`), validated
  server env (`parseServerEnv`), shadcn/ui tokens on Tailwind v4.
- Guest identity: `proxy.ts` issues a signed `ta_session` cookie; `IdentityService` resolves a
  `Principal` onto the tRPC context (`session.whoami`). See
  [architecture/](architecture/index.md#identity).
- `packages/db`: Prisma 7 on the Neon serverless adapter; the `outbox_events` table and the seeded catalog (venues, sections, rows, events,
  per-event seats). `events.list`, `events.get` and `seats.map` serve it.
- Quality gate: Biome (warnings fail), strict `tsc`, Vitest, enforced by `ralph-loop.sh`.

No domain features yet. They arrive as tickets split from the
[MVP spec](specs/ticketarena-mvp.md) by `/to-tickets`.

## Decisions

The `/grill-me` session settled every former open decision; see the
[MVP spec](specs/ticketarena-mvp.md) and [ADRs 0004–0013](adr/index.md):

| Former open decision        | Settled by                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker                      | NATS JetStream behind `MessageBus` ([0004](adr/0004-nats-jetstream-message-bus.md))                                                            |
| Outbox relay hosting        | Polling relay in one worker app on Fly.io ([0013](adr/0013-deployment-topology.md))                                                            |
| Admission order and rate    | Random pre-queue, then FIFO; token bucket + `maxActive` ([0008](adr/0008-waiting-room-admission.md))                                           |
| Queue position delivery     | Client polling every 3s ([0008](adr/0008-waiting-room-admission.md))                                                                           |
| Seat holds, oversell        | Postgres rows, ordered `FOR UPDATE`, buyer advisory lock ([0005](adr/0005-postgres-seat-state-row-locks.md))                                   |
| Payments, idempotency       | Simulated provider, saga + ledger, three layers ([0006](adr/0006-booking-saga-payment-ledger.md), [0007](adr/0007-three-layer-idempotency.md)) |
| Identity                    | Anonymous sessions behind `IdentityService` ([0012](adr/0012-identity-service-seam.md))                                                        |
| Deployment and load testing | Vercel, Neon, Upstash, Fly.io; k6 locally ([0013](adr/0013-deployment-topology.md))                                                            |

## Open decisions

None for the MVP. Phase-2 topics (authentication, payment retry UI, provider reconciliation,
dynamic queue activation, bot mitigation) are listed under "Out of Scope" in the spec.
