# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace               | Responsibility                                                                                                                                                                                                                                                             | Depends on                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/web`              | Next.js App Router UI and the tRPC API (the only public entry)                                                                                                                                                                                                             | `db`, `booking`, `contracts`, `waiting-room` |
| `packages/db`           | Prisma schema, migrations, client factory over the Neon adapter                                                                                                                                                                                                            | (none)                                       |
| `packages/contracts`    | Zod schemas for the event envelope and payloads (`seat.held`, `hold.released`, `hold.expired`, `order.placed`, `payment.succeeded`, `order.confirmed`, `order.expired`); `Logger` port, id helpers                                                                         | (none)                                       |
| `packages/booking`      | `BookingService`: `holdSeats` (1–6 seats, buyer limit), `getHold`, `releaseHold`, `placeOrder`, `getOrder`, `sweepExpired` (sweeper step: holds, then overdue orders); payment saga handler over the pure `decide` matrix; `BookingMetrics` port, Redis adapter and reader | `contracts`, `db`                            |
| `packages/waiting-room` | `QueueService` (`join`, `status`, `leave`), `QueueStore` port with a node-redis adapter (atomic Lua scripts, prefixed keys), `AdmissionPolicy` (schedule). See [waiting-room](waiting-room.md)                                                                             | (none)                                       |
| `packages/messaging`    | `MessageBus` port, JetStream adapter (the only `@nats-io/*` importer), outbox relay, consumer runner                                                                                                                                                                       | `db`                                         |
| `apps/worker`           | Long-running worker: validates env, ensures the topology, runs the relay, the sweeper and consumer runners, serves `/health`; hosts the mock Payment and Notification modules                                                                                              | `db`, `booking`, `messaging`                 |

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

`Browser → proxy.ts (guards /admin, ensures ta_session) → TRPCReactProvider (httpBatchLink, superjson) → /api/trpc/[trpc] → createTRPCContext (resolves Principal and isAdmin, attaches `db`) → appRouter → procedure(ctx)`

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
- **Metrics config:** `UPSTASH_REDIS_REST_URL` (https; plain http only to `localhost`, `127.0.0.1`
  or `[::1]`, so the token never crosses a network in clear text) and `UPSTASH_REDIS_REST_TOKEN` are read only
  by `parseMetricsEnv`, called from `ctx.metrics()` and `ctx.metricsReader()`
  (`apps/web/src/server/upstash-metrics.ts`), never by `createTRPCContext`. The first call builds a
  `fetch`-based Upstash REST client (`HINCRBY`, `HGETALL`, bearer token, timeout) behind
  `createRedisBookingMetrics` (or `createRedisBookingMetricsReader`) and caches the outcome per
  process. Missing or invalid values therefore fail only procedures that use metrics, with an error
  naming the variable; the failure is logged once through the app logger and later calls rethrow it
  without re-parsing. Health and session requests are unaffected. Same per-concern parsing as
  `parseSessionEnv` and `parseDatabaseEnv`.
- **Admin access** (`identity/admin-session.ts`, `identity/admin-login.ts`): separate from the
  Principal. `POST /api/admin/login` (form field `password`) compares the password with
  `ADMIN_PASSWORD` in constant time (both as HMACs through `subtle.verify`) and answers with a 303:
  to `/admin` with a `ta_admin` cookie, or back to `/admin/login?error=invalid`. The cookie value
  is `<expiry, epoch seconds>.<HMAC-SHA256 of "ta_admin:<expiry>" under SESSION_SECRET>`;
  `httpOnly`, `Secure`, `SameSite=Strict`, 8 hours. The purpose prefix keeps a guest signature from
  passing as an admin one; the expiry is signed, so the server enforces the lifetime. Rotating
  `SESSION_SECRET` logs out operators too; changing `ADMIN_PASSWORD` does not revoke issued cookies.
  `proxy.ts` redirects `/admin` and `/admin/*` (except `/admin/login`) to the login page without a
  valid cookie; `createTRPCContext` sets `ctx.isAdmin`, and `adminProcedure` rejects every admin
  procedure with `UNAUTHORIZED` unless it is `true`. Login is not rate-limited and there is no
  logout yet. `ADMIN_PASSWORD` (at least 12 characters) is validated in `parseServerEnv`, and by
  `parseAdminEnv` for the login route only, so it cannot break buyer requests.
- **Known MVP limitation:** clearing cookies yields a new guest session, so per-session guest
  limits (e.g. the 6-ticket limit) can be bypassed until authentication exists.
- **API:** `session.whoami` returns the caller's principal.

## Admin API

`admin.snapshot` (`routers/admin.ts`, `adminProcedure`) returns, at `takenAt`: orders by status
and `pendingPayments` (orders in `PENDING_PAYMENT`; booking never reads the payment schema,
ADR 0009), and per event (all events, by `onSaleAt`) seats by stored status, `queueLength` and
`activeShoppers` (`QueueStore.counts`) and the booking counters (`hold_ok`, `seat_unavailable`,
`race_lost`, `booking_busy`, `limit_exceeded`) read through `ctx.metricsReader()`
(`createRedisBookingMetricsReader` over the Upstash client's `HGETALL`). Counters are best-effort:
when they cannot be read the event's `metrics` is `null` and the rest is still returned. A `HELD`
seat whose hold lapsed counts as held until the sweeper expires it. The figures are separate reads,
not one transaction. Outbox, consumer and NATS figures, the live feed and stuck refunds are not
built yet.

**Demo actions.** Both take no input: the server picks the one event flagged `demo` (anything but
exactly one is `PRECONDITION_FAILED`), so no request can aim them at a real event. Both are limited
to **1 per 10 s per action, globally** (not per session) by `ctx.rateLimiter()`
(`rate-limiter.ts`: `SET admin:rate:<action> 1 NX PX 10000` on the Upstash store, shared by every
instance; a refusal is `TOO_MANY_REQUESTS` naming the seconds to wait from `PTTL`). The limit is
taken first, so a refused call has no effect.

- `admin.runRace`: picks the demo event's first `AVAILABLE` seat (none: `PRECONDITION_FAILED`,
  reset first) and has 100 synthetic sessions (fresh random session id = buyer key each) call
  `BookingService.holdSeats` on it concurrently, in-process, bypassing admission by design. Returns
  `buyers`, `successes`, `seatUnavailable`, `bookingBusy`, `otherErrors`, `durationMs` (injected
  clock) and the `winner` (`holdId`, `correlationId`). Only the winner writes an outbox event, its
  normal `seat.held`; that row is the race's entry for the live feed (ticket 36), found by the
  winner's `correlationId`. Counters go to `ctx.metrics()` when configured.
- `admin.resetDemo`: `BookingService.resetEvent(demoId)` (see
  [database](../database/index.md#demo-reset)); `RESET_BLOCKED`/`NOT_DEMO_EVENT` become
  `PRECONDITION_FAILED`. After it commits, the demo event's booking counters
  (`ctx.metricsReset()`, `DEL` of the counter hash) and its waiting-room keys
  (`QueueStore.clearEvent`) are deleted. Postgres goes first because it is the authority; a Redis
  failure fails the call, and repeating it is harmless.

## Catalog API

Routers in `apps/web/src/server/routers/`: `events` (`list`, `get`) and `seats` (`map`), sharing
zod schemas in `catalog-schemas.ts`. They read through `ctx.db`, a process-wide Prisma client
created lazily from `DATABASE_URL` and `DATABASE_DRIVER` (`neon`, the default, or `pg` for a local
Postgres; `parseDatabaseEnv` validates only these two). A missing
event is a `NOT_FOUND` tRPC error. Integration tests run against real Postgres. See
[database](../database/index.md).

## Web UI

Code: `apps/web/src/app/` (routes) and `apps/web/src/components/` (client components).

- **Pages:** `/events` lists events (venue, on-sale date, on-sale status) and links to
  `/events/[eventId]`, which shows the event (venue, on-sale status, a "Prices per section" table)
  and its seat map. `/admin/login` is a plain HTML form posting to `/api/admin/login`; `/admin`
  (behind the proxy guard) shows the admin dashboard. The queue room, checkout and order status
  pages are not built yet.
- **Admin dashboard** (`components/admin/admin-dashboard.tsx`): polls `admin.snapshot` every 1 s
  (`refetchInterval`, `SNAPSHOT_POLL_MS`) and shows pending payments, an "Orders by status" table
  and a "Seats, queue and metrics per event" table. Polling stops once a poll returns
  `UNAUTHORIZED`, and the page offers a link back to the login. A "Demo event" card has "Run race"
  and "Reset demo" buttons (`useMutation`); the result shows in a `role="status"` line ("Race
  result": successes, seat unavailable, booking busy, duration, winner's correlation id; "Reset
  result": holds, orders and ledger rows deleted, seats freed) and a failure, such as the rate
  limit, in a `role="alert"` line. The next poll shows the new seat state.
- **Server state:** components read `events.list`, `events.get`, `seats.map` and `admin.snapshot` through TanStack
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
  the event and admin tests fake only `fetch` behind a real tRPC client (and the clock, with
  `vi.useFakeTimers({ shouldAdvanceTime: true })`, for the 1 s poll).

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
