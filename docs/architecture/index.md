# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace               | Responsibility                                                                                                                                                                                                                    | Depends on                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/web`              | Next.js App Router UI and the tRPC API (the only public entry)                                                                                                                                                                    | `db`, `booking`, `contracts`, `waiting-room` |
| `packages/db`           | Prisma schema, migrations, client factory over the Neon adapter                                                                                                                                                                   | (none)                                       |
| `packages/contracts`    | Zod schemas for the event envelope and payloads (`seat.held`, `hold.released`, `hold.expired`, `order.placed`, `payment.succeeded`, `order.confirmed`, `order.expired`); `Logger` port, id helpers                                | (none)                                       |
| `packages/booking`      | `BookingService`: `holdSeats` (1–6 seats, buyer limit), `getHold`, `releaseHold`, `placeOrder`, `getOrder`, `sweepExpired` (sweeper step: holds, then overdue orders); payment saga handler; `BookingMetrics` port, Redis adapter | `contracts`, `db`                            |
| `packages/waiting-room` | `QueueService` (`join`, `status`, `leave`), `QueueStore` port with a node-redis adapter (atomic Lua scripts, prefixed keys), `AdmissionPolicy` (schedule). See [waiting-room](waiting-room.md)                                    | (none)                                       |
| `packages/messaging`    | `MessageBus` port, JetStream adapter (the only `@nats-io/*` importer), outbox relay, consumer runner                                                                                                                              | `db`                                         |
| `apps/worker`           | Long-running worker: validates env, ensures the topology, runs the relay, the sweeper and consumer runners, serves `/health`; hosts the mock Payment and Notification modules                                                     | `db`, `booking`, `messaging`                 |

New modules are added when a slice needs them, not speculatively.

## Conventions that shape the code

- **Dependency direction:** `apps/*` → `packages/*`, never the reverse. Packages must not read
  `process.env`; configuration is validated at the app boundary (`parseServerEnv`) and injected.
- **tRPC context as the composition root:** infrastructure (clock, db, redis, outbox) enters
  procedures through `TRPCContext`. Procedures never import a client directly, which keeps them
  testable through `createCaller` with fakes at system boundaries only.
- **Deep modules, narrow interfaces:** each module exposes a small surface (e.g.
  `join/status/leave` for the waiting room) and hides its storage layout.
- **Packages ship TypeScript source** (`exports` → `src/index.ts`); there is no package build
  step. Turborepo caches `typecheck`, `test`, `build` and `db:generate`.
- **Errors:** validate at boundaries (zod), fail fast with actionable messages, and surface
  domain failures as typed tRPC errors rather than thrown strings.

## Request path today

`Browser → proxy.ts (ensures ta_session) → TRPCReactProvider (httpBatchLink, superjson) → /api/trpc/[trpc] → createTRPCContext (resolves Principal, attaches `db`) → appRouter → procedure(ctx)`

## Identity

Decision: [ADR 0012](../adr/0012-identity-service-seam.md). Code: `apps/web/src/server/identity/`.

- **Session cookie:** `apps/web/src/proxy.ts` (Next.js 16 `proxy.ts`) issues `ta_session` on first
  visit: a random 128-bit id plus its HMAC-SHA256 under `SESSION_SECRET`; `httpOnly`, `Secure`,
  `SameSite=Lax`, 7 days. A cookie whose signature fails is replaced, never trusted or repaired.
  Signing uses Web Crypto so the proxy and route handlers share one implementation. When the
  proxy issues a cookie it also forwards it on the downstream request, so the first request
  resolves the same session the browser receives.
- **`IdentityService.resolve(cookies)`** returns a `Principal` and never throws for a guest. With
  no trusted cookie it returns an ephemeral session id; the proxy is what persists a fresh one.
- **Context seam:** `createTRPCContext` resolves the `Principal` once per request and puts it on
  `TRPCContext`. Procedures read `ctx.principal`, never cookies. `Principal` is a discriminated
  union (`guest` has no `userId`; `user` always has one). `buyerKey(principal)` is the `userId`
  for a user and the `sessionId` for a guest, so phase-2 authentication will not change booking procedures.
- **Config:** `SESSION_SECRET` (at least 32 bytes) is validated in `parseServerEnv`; the error
  names the field. The proxy and `createTRPCContext` use `parseSessionEnv`, which validates only
  that variable, so an unrelated missing setting (e.g. the Redis token) cannot break page requests.
- **Metrics config:** `UPSTASH_REDIS_REST_URL` (https) and `UPSTASH_REDIS_REST_TOKEN` are read only
  by `parseMetricsEnv`, called from `ctx.metrics()` (`apps/web/src/server/upstash-metrics.ts`),
  never by `createTRPCContext`. The first call builds a `fetch`-based Upstash REST client
  (`HINCRBY`, bearer token, timeout) behind `createRedisBookingMetrics` and caches the outcome per
  process. Missing or invalid values therefore fail only procedures that use metrics, with an error
  naming the variable; the failure is logged once through the app logger and later calls rethrow it
  without re-parsing. Health and session requests are unaffected. Same per-concern parsing as
  `parseSessionEnv` and `parseDatabaseEnv`.
- **Known MVP limitation:** clearing cookies yields a new guest session, so per-session guest
  limits (e.g. the 6-ticket limit) can be bypassed until authentication exists.
- **API:** `session.whoami` returns the caller's principal.

## Catalog API

Routers in `apps/web/src/server/routers/`: `events` (`list`, `get`) and `seats` (`map`), sharing
zod schemas in `catalog-schemas.ts`. They read through `ctx.db`, a process-wide Prisma client
created lazily from `DATABASE_URL` (`parseDatabaseEnv` validates only that variable). A missing
event is a `NOT_FOUND` tRPC error. Integration tests run against real Postgres. See
[database](../database/index.md).

## Web UI

Code: `apps/web/src/app/` (routes) and `apps/web/src/components/` (client components).

- **Pages:** `/events` lists events (venue, on-sale date, on-sale status) and links to
  `/events/[eventId]`, which shows the event (venue, on-sale status, a "Prices per section" table)
  and its seat map. The queue room, checkout, order status and `/admin` pages are not built yet.
- **Server state:** components read `events.list`, `events.get` and `seats.map` through TanStack
  Query (`useTRPC().….queryOptions`) under `TRPCReactProvider`; no server data is copied into
  client stores. The on-sale badge compares `onSaleAt` with the visitor's clock and is only a
  hint. The catalog has no performance date, so the date shown is the on-sale time.
- **Seat map** (`components/seat-map/seat-map.tsx`): one CSS grid area per section (a `fieldset`
  named "Section X"), and inside it a grid of native `<button>`s placed by row and seat number.
  Each button's `aria-label` is "Section, row, seat, price, status" and `aria-pressed` reflects
  selection. Held, in-checkout and sold seats stay focusable with `aria-disabled`. Tab, Enter and
  Space work as for any button; arrow keys move focus to the neighbouring seat in the section.
  A `role="status"` line announces "n of 6 seats selected" and the limit.
- **Seat selection** (`components/seat-map/seat-selection.tsx`): a Zustand store created per
  `SeatSelectionProvider` (keyed by event, so it never leaks across events or server requests);
  `toggleSeat` adds only `AVAILABLE` seats, at most `MAX_SELECTED_SEATS` (6), and always allows
  deselecting. It is a UI rule only: the buyer limit is enforced by `holdSeats`.
- **shadcn/ui:** `components/ui/` holds the copied `Card`, `Badge` and `Table` sources (Badge
  without `asChild`).
- **Component tests** run in jsdom (`// @vitest-environment jsdom` per file) with Testing Library;
  the event tests fake only `fetch` behind a real tRPC client.

## Worker

Code: `apps/worker/src/`; decision: [ADR 0013](../adr/0013-deployment-topology.md). `startWorker` ensures
the JetStream topology first, then starts the outbox **relay** (polls every 250 ms, batch of 100) and one
**consumer runner** per registered consumer, and the **sweeper** (`sweeper.ts`: calls
`BookingService.sweepExpired()`, which expires holds and then overdue orders, at start and then 15 s after each sweep ends, `SWEEP_INTERVAL_MS`; a
failed sweep is logged and retried next time; `stop()` cancels the wait at once), the waiting-room **admission ticker** (every 1 s, `ADMIT_INTERVAL_MS`) and **slot reaper** (every 15 s, `REAP_INTERVAL_MS`) in `admission.ts` on the generic `periodic-loop.ts` (same run-then-wait, log-and-retry, prompt-stop behaviour), each a pass over every event (see [waiting room](waiting-room.md#admission-and-slots)), and serves `GET /health`. Configuration is validated once in
`parseWorkerEnv` (`DATABASE_URL`, `NATS_URL`, `REDIS_URL`, `PORT`, `ADMIT_RATE_PER_SECOND` default 10, `MAX_ACTIVE` default 100) and injected. Details: [messaging](../messaging/index.md).

## Logging and ids

- **Logger injection:** each app creates a `pino` logger at its boundary (`apps/web`
  `createTRPCContext`, `apps/worker` `main.ts`) and injects it (`TRPCContext.logger`,
  `WorkerOptions.logger`). Packages accept an optional `Logger` (the narrow port in
  `packages/contracts`, default `silentLogger`) and never create one from global state.
- **Ids on every line:** booking, the outbox relay and the consumer runner log through a child
  logger bound by `envelopeLogBindings` to `correlationId`, `causationId` and, when known,
  `holdId`, `orderId`, `paymentId`. A body that is not a valid envelope is logged without ids.
- **Causation:** a consumer handler writes follow-up events through `emit` (the third handler
  argument of the consumer runner). `emit` applies `causedBy(message)` itself: the
  `correlationId` is unchanged and `causationId` is the handled message's `id`; the outbox row
  commits in the handler's transaction and a non-envelope message cannot emit. Events from
  `holdSeats`/`releaseHold`/`placeOrder` start the chain with `causationId: null`.

## Children

- [Waiting room](waiting-room.md): queue keys, Lua scripts, ordering invariants, `queue.*` API.
