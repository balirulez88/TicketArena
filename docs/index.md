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

| Area                | Status                                        | Map                                    |
| ------------------- | --------------------------------------------- | -------------------------------------- |
| Monorepo & modules  | scaffolded                                    | [architecture/](architecture/index.md) |
| Database & Prisma   | catalog, holds, orders, payment, notification | [database/](database/index.md)         |
| Async messaging     | relay, consumer runner, recovery runbook      | [messaging/](messaging/index.md)       |
| Agent workflow & CI | operational                                   | [workflow/](workflow/index.md)         |
| Deployment & ops    | Vercel, Fly.io, Neon, Upstash; setup runbook  | [operations/](operations/index.md)     |
| Technical debt      | frozen record (harness-v1 era)                | [technical-debt.md](technical-debt.md) |
| Learning notes      | one per ticket: decision, alternatives, Q&A   | [learning/](learning/index.md)         |
| Decisions (ADRs)    | 17 accepted                                   | [adr/](adr/index.md)                   |
| Feature specs       | MVP ready                                     | [specs/](specs/index.md)               |
| Domain vocabulary   | seeded                                        | [glossary.md](glossary.md)             |

## What exists today

- Turborepo + pnpm monorepo: `apps/web`, `apps/worker`, `packages/db`, `packages/contracts`,
  `packages/booking`, `packages/messaging`, `packages/waiting-room`.
- `apps/web`: Next.js App Router with an end-to-end tRPC tracer (`health.check`), validated
  server env (`parseServerEnv`), shadcn/ui tokens on Tailwind v4. The database client is built on
  a procedure's first `ctx.db()` call, so requests that do not use it never need `DATABASE_URL`.
- Web UI: `/events` and `/events/[eventId]` (venue, on-sale status, prices per section, seat map
  of native buttons with accessible names; up to 6 seats selectable in a Zustand store, server
  data via TanStack Query). The event page is also the queue room (join, position and ETA,
  `queue.status` polled every 3 s) and, once admitted, holds the selection with a countdown to
  `holdExpiresAt`, a release button and a distinct message per hold refusal (a reload restores a
  live hold through `booking.activeHold`); the seat map and
  `queue.status` keep polling as the heartbeat. The live hold carries the checkout form (zod
  validated email and optional phone; one `idempotencyKey` per checkout attempt, reused on
  retries; distinct `HOLD_EXPIRED` and `IDEMPOTENCY_KEY_REUSED` messages), and a placed order is
  followed on the event page and at `/orders/[orderId]`, polling `booking.getOrder` every 2 s until
  it is final. See [architecture/](architecture/index.md#web-ui).
- Admin: `/admin/login` checks `ADMIN_PASSWORD` and sets a signed `ta_admin` cookie (8 h); every
  attempt first takes the global admin limit (1 per 10 s, fails closed), and `/api/admin/logout`
  clears the cookie (a copied cookie stays valid until it expires). `proxy.ts` guards `/admin` and `adminProcedure` guards admin procedures (`UNAUTHORIZED`).
  `/admin` polls `admin.snapshot` every second: seats by status per event, orders by status,
  pending payments, queue length, active shoppers and the booking counters. `admin.runRace` races
  100 synthetic buyers for one demo seat (exactly one wins) and `admin.resetDemo` frees the demo
  event's seats and queue while keeping every order and ledger row (refused while a demo order
  awaits payment or a refund obligation is open); both touch only
  the `demo` event and are limited to 1 per 10 s globally. The snapshot also carries
  `deadlock_retry`, `late_delivery_refund`, outbox lag per service, the worker's consumer and DLQ
  figures (from its `/health` at the optional `WORKER_HEALTH_URL`) and `refund_pending_age_max`;
  `admin.feed` is the live feed (every outbox by cursor `(createdAt, id)`, with status, groupable by
  correlation id) and `admin.stuckRefunds` / `admin.retryRefund` list open refund obligations with
  their age and retry one in manual review. See
  [architecture/](architecture/index.md#admin-api).
- Guest identity: `proxy.ts` issues a signed `ta_session` cookie; `IdentityService` resolves a
  `Principal` onto the tRPC context (`session.whoami`). See
  [architecture/](architecture/index.md#identity).
- `packages/db`: Prisma 7 on the Neon serverless adapter; the `outbox_events` table and the seeded catalog (venues, sections, rows, events,
  per-event seats; the seeder is a separate `@ticketarena/db/seed` entry point, run by the worker's
  `db:seed` command, and a migration merges duplicate venue names before `venues.name` became unique). `events.list`, `events.get` and `seats.map` serve it. The `holds` table backs
  `booking.holdSeats` / `booking.getHold` / `booking.activeHold` / `booking.releaseHold` (`packages/booking`), which write
  `seat.held` and `hold.released` outbox events; the worker's sweeper expires abandoned holds every 15 s and writes `hold.expired`, and expires unpaid orders at `paymentDeadline + 60 s` (`order.expired`, seats freed); `orders` and `order_lines` back `booking.placeOrder` / `booking.getOrder`, which write
  `order.placed`; envelope schemas live in `packages/contracts`.
- `packages/messaging` and `apps/worker`: the `MessageBus` port with its JetStream adapter, the outbox relay (250 ms, batch of 100; a full stream rejects publishes and the rows wait `PENDING`, measured as outbox lag; a row that fails permanently 5 times becomes `FAILED`, keeps its payload and history, releases its aggregate, raises the `/health` alert and is recovered by `outbox:requeue`, [ADR 0022](adr/0022-terminal-failed-outbox-events.md)), the consumer runner, consumer recovery (`consumer:recover` recreates a durable by ADR 0011's rules: ack floor, `processed_messages` checkpoint scan, earliest; `outbox:republish` re-sends `PUBLISHED` rows of a time range under their original ids; an hourly retention job deletes published outbox rows and `processed_messages` after 14 days; [runbook](messaging/consumer-recovery.md)), the sweeper, the waiting-room admission ticker and reaper, and the worker app with `/health` (Redis, `FAILED` outbox rows, and consumer lag, pending acks, redeliveries, DLQ size and oldest age).
- `packages/waiting-room`: `QueueService` with the `QueueStore` port, its node-redis and Upstash
  REST adapters (the same atomic Lua scripts and key layout, configurable key prefix, one shared
  contract suite run against both) and the schedule `AdmissionPolicy`; served as
  `queue.join` / `queue.status` / `queue.leave` over `REDIS_URL`, with the admission token (JWT, `ADMISSION_SECRET`) gating `booking.holdSeats` (node-redis, every call bounded: a Redis outage fails queue calls fast with `SERVICE_UNAVAILABLE`, issues no admission, skips only the token's revocation lookup, and never stops booking or the worker; choosing Upstash in
  production belongs to deployment). The worker's admission ticker (1 s) and slot reaper (15 s, in
  bounded calls of at most 100 slots, up to 50 per event per pass) run on the same store. See
  [architecture/waiting-room](architecture/waiting-room.md).
- Deployment ([operations/](operations/deployment.md)): `.github/workflows/deploy.yml` runs after
  CI passes on `main`: `prisma migrate deploy` on the direct Neon URL, then the web app to Vercel
  (git deployments off in `apps/web/vercel.json`; `parseServerEnv` refuses a direct Neon URL, so
  the web app runs on `adapter-neon` over the pooled one) and the worker to Fly.io
  (`infra/fly/worker`). NATS is its own Fly app on a volume (`infra/fly/nats`, `sync_interval:
  always`); neither Fly app is public, the worker reaches NATS over the private network. A target
  whose secrets are missing is skipped, not failed; the one-time setup is a runbook. Nothing is
  deployed yet.
- Structured logging: each app injects a `pino` logger; booking, the relay and the consumer runner log with a child logger bound to `correlationId`/`causationId` (plus `holdId`, `orderId`, `paymentId`), and both app loggers redact buyer email and phone from every line, serialized errors included. See [architecture/](architecture/index.md#logging-and-ids).
- Quality gate: Biome (warnings fail), strict `tsc`, Vitest, enforced by `ralph-loop.sh`.
- Execution drivers: `ralph-loop.sh` (default) and the opt-in lead driver (`RALPH_DRIVER=lead`, [ADR 0017](adr/0017-opt-in-lead-driver.md)); the host judges both the same way. A candidate rejected only for a ticket defect can be replayed on the amended base by `scripts/ralph-replay.mjs` ([ADR 0018](adr/0018-host-side-replay-of-a-rejected-candidate.md)).

A buyer can hold up to 6 seats per event in one all-or-nothing action (the limit counts held, in-checkout and sold seats, enforced under a per-buyer advisory lock) release a hold to free its seats at once (an abandoned hold frees them after 10 minutes: an expired hold's seats count as free for anyone, and the sweeper expires it), and place an order for the hold (idempotent per checkout key: a retried, concurrent or later replayed checkout yields the same single order, and a key reused for a different request is `IDEMPOTENCY_KEY_REUSED`); the mock Payment service captures it and the booking saga confirms the order (`CONFIRMED`, seats `SOLD`, ledger `APPLIED`) and the mock Notification service records one confirmation per channel. An order never paid expires at its payment deadline plus a 60 s settlement grace: its in-checkout seats are freed in that same transaction (never earlier, not even when the hold's own expiry passes) and the buyer gets an expiry email. Concurrent holds on one seat yield exactly one winner; visibly taken seats are refused by a lock-free snapshot, and the web app counts each hold's and order's outcome per event in Upstash Redis (`hold_ok`, `seat_unavailable`, `race_lost`, `limit_exceeded`, `deadlock_retry`, `booking_busy`) best-effort: a failed or lost increment never fails or delays a booking. Holding seats and placing an order never hang under contention: each transaction runs with `lock_timeout` 3 s and `statement_timeout` 5 s, a deadlock, lock timeout or serialization failure retries the whole transaction up to 3 times with jitter (`deadlock_retry`), and saturation or exhausted retries are a retryable `BOOKING_BUSY` (`booking_busy`, tRPC `TOO_MANY_REQUESTS`), while other failures stay internal errors. A buyer can join an event's waiting room, see their position and estimated wait, keep their position on a refresh or re-join (a re-join while admitted reports `ADMITTED` and keeps the admission), and leave; buyers who join before the on-sale get random positions ahead of everyone who joins later, who queue in arrival order; before the queue opens `join` says when it opens and admits no one, and after it closes `join` admits at once (`ADMISSIBLE`). No seat can be held before an event's on-sale (`NOT_ON_SALE`). The worker admits buyers from the queue head every second, at most `admitRate` per second (burst `admitRate`) and never beyond `maxActive` active shoppers per event (worker configuration, defaults 10 and 100); an admitted buyer's `queue.status` reports `ADMITTED`, keeps its slot alive and hands the browser a signed admission token (httpOnly cookie `ta_adm_<eventId>`, valid 30 minutes from admission), and the slot frees, revoking the admission, when the buyer leaves, places an order, or is reaped (idle over 90 s or admission older than 30 min). Holding seats requires that token for the same session and event with its admission still live (else `FORBIDDEN`); only while Redis is unreachable is the revocation lookup skipped, so a revoked token can stay usable until its expiry (at most 30 minutes) while no new admission is issued (ADR 0008 amendment); checkout of a valid hold does not, so an admission expiring mid-checkout breaks nothing. A definitively failed payment (`+fail@`: `payment.failed` with `final: true`) cancels a `PENDING_PAYMENT` order with no applied payment (`CANCELLED`, its seats freed in that transaction) and the buyer gets a cancellation email; a failed attempt that is not final is logged and counted (`payment_attempt_failed`) and leaves the order open until its deadline. A payment captured after the deadline (`+late@`) is never kept: the saga expires the order, frees its seats (never reclaiming them for that payment) and records a refund obligation (`REFUND_REQUESTED` ledger row plus `payment.refund_requested`) in one transaction; a capture on an expired, cancelled or confirmed order, or with a mismatched amount, gets the same obligation, and a capture whose order no longer exists is refunded once per payment id instead of being poisoned, its obligation kept as an orphan refund obligation (one per payment id, independent of outbox retention) that `payment.refunded` closes. The mock Payment service executes each refund obligation exactly once per payment id (one `payment.refunds` row even for duplicate requests, AT-23, each duplicate re-announcing that refund with `payment.refunded`, so a lost confirmation is recovered) and the saga then records the ledger row (or orphan obligation) as `REFUNDED`. The buyer is told when the refund is initiated and when it completes (email, plus SMS when a phone was given), and every final outcome (confirmed, cancelled, expired, refund initiated, refund completed) yields exactly one notification record per channel even under duplicate delivery (AT-43). No refund obligation is forgotten: the worker's reconciler (every 5 min) re-emits `payment.refund_requested` for a ledger row or orphan obligation whose last request is 10 minutes old, counting `refundAttempts`, and after 3 unanswered re-emits moves it to `MANUAL_REVIEW`, from which `BookingService.retryRefund` brings it back; `refundPendingAgeMax` measures `refund_pending_age_max` for the dashboard, which lists the open obligations with their age and retries one in manual review. Remaining features arrive as tickets split from the
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

No product decision is open for the MVP. Phase-2 topics (authentication, payment retry UI,
provider reconciliation, dynamic queue activation, bot mitigation) are listed under "Out of Scope"
in the spec. Engineering decisions still open, from the technical-debt audit of 2026-11-14:

| Open decision                                 | Where it is decided                                                                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The rejected branch on the public remote      | Ticket 52's maintainer steps: preserve evidence, check for sensitive data, then the maintainer explicitly approves removing it (TD-059). Pushing rejected work is off by default ([ADR 0021](adr/0021-rejected-work-is-not-published-by-default.md)) |
| A global, fail-closed debt gate               | Decided: [ADR 0020](adr/0020-global-fail-closed-debt-hold.md). TD-059 holds every ticket not `ready-for-human` (`Blocks: ALL_AGENT_TICKETS`); no Ralph run starts until it is resolved                                                               |
| Recovering ticket 54's container-rejected run | Ticket 54's unblock conditions: the dependency lands on `main` by a reviewed chore commit first                                                                                                                                                      |
