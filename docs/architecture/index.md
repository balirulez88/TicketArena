# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace               | Responsibility                                                                                                                                                                                                                                                                                                                          | Depends on                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/web`              | Next.js App Router UI and the tRPC API (the only public entry)                                                                                                                                                                                                                                                                          | `db`, `booking`, `contracts`, `waiting-room` |
| `packages/db`           | Prisma schema, migrations, client factory over the Neon adapter                                                                                                                                                                                                                                                                         | (none)                                       |
| `packages/contracts`    | Zod schemas for the event envelope and payloads (`seat.held`, `hold.released`, `hold.expired`, `order.placed`, `payment.succeeded`, `payment.failed`, `order.confirmed`, `order.cancelled`, `order.expired`); `Logger` port, id helpers                                                                                                 | (none)                                       |
| `packages/booking`      | `BookingService`: `holdSeats` (1–6 seats, buyer limit), `getHold`, `releaseHold`, `placeOrder`, `getOrder`, `sweepExpired` (sweeper step: holds, then overdue orders); payment saga handler over the pure `decide` matrix (confirms, or cancels on a final failure); `BookingMetrics` and `SagaMetrics` ports, Redis adapter and reader | `contracts`, `db`                            |
| `packages/waiting-room` | `QueueService` (`join`, `status`, `leave`), `QueueStore` port with a node-redis adapter (atomic Lua scripts, prefixed keys), `AdmissionPolicy` (schedule). See [waiting-room](waiting-room.md)                                                                                                                                          | (none)                                       |
| `packages/messaging`    | `MessageBus` port, JetStream adapter (the only `@nats-io/*` importer), outbox relay, consumer runner                                                                                                                                                                                                                                    | `db`                                         |
| `apps/worker`           | Long-running worker: validates env, ensures the topology, runs the relay, the sweeper and consumer runners, serves `/health`; hosts the mock Payment and Notification modules                                                                                                                                                           | `db`, `booking`, `messaging`                 |

New modules are added when a slice needs them, not speculatively.

## Conventions that shape the code

- **Dependency direction:** `apps/*` → `packages/*`, never the reverse. Packages must not read
  `process.env`; configuration is validated at the app boundary (`parseServerEnv`) and injected.
- **tRPC context as the composition root:** infrastructure (clock, db, redis, outbox) enters
  procedures through `TRPCContext`. Procedures never import a client directly, which keeps them
  testable through `createCaller` with fakes at system boundaries only. Booking procedures get
  their service from `bookingServiceFor(ctx)`; `composeBooking` and `connectBooking` turn one
  `BookingTimeouts` value into a `BookingRuntime` (client plus those timeouts), and
  `createTRPCContextFactory(runtime)` sets both `ctx.db` and the required `ctx.bookingTimeouts`
  from it (see
  [database](../database/index.md#transaction-timeouts-retries-and-booking_busy)).
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
  The admission token cookie (`ta_adm_<eventId>`) is likewise read and written only behind
  `ctx.admissionTokens`, which hands out verified claims; `admittedProcedure` gates
  `booking.holdSeats` with it (see [waiting room](waiting-room.md#admission-token)).
- **Config:** `SESSION_SECRET` and `ADMISSION_SECRET` (each at least 32 bytes) are validated in
  `parseServerEnv`; the error names the field. `ADMISSION_SECRET` is read lazily
  (`parseAdmissionEnv`) only when an admission token is signed or verified. The proxy and `createTRPCContext` use `parseSessionEnv`, which validates only
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
  `/events/[eventId]`, which shows the event (venue, on-sale status, a "Prices per section" table),
  the queue step and its seat map. `/admin/login` is a plain HTML form posting to
  `/api/admin/login`; `/admin` (behind the proxy guard) shows the admin dashboard.
  `/orders/[orderId]` shows one order's status (owner only; another buyer's or a malformed id
  reads "Order not found."). Checkout is not its own route: it is the live hold on the event page.
- **Queue room** (`components/queue/queue-room.tsx`): a step on `/events/[eventId]`, not its own
  route. `useQueueStatus` reads `queue.status` on load and polls it every 3 s (`QUEUE_POLL_MS`,
  also in a background tab) while the session is `QUEUED` or `ADMITTED`; a visitor who has not
  joined is not polled. "Join the queue" calls `queue.join`: `NOT_OPEN` shows when the queue
  opens; any other result re-reads `queue.status` at once, so an immediate admission
  (`ADMISSIBLE`, `ADMITTED`) gets its admission cookie minted before the buyer can hold. While
  `QUEUED` a "Queue room" region shows position and ETA; the first `ADMITTED` poll replaces it with
  an "It's your turn" status and turns on holding. `NOT_QUEUED` (never joined, left or reaped)
  shows the join button again.
- **Holding** (`components/hold/hold-controls.tsx`): under the seat map; the "Hold n seats"
  button shows only while admitted, but a live hold and a refusal stay on screen if the admission
  lapses (30 min, fixed) meanwhile. "Hold n seats" sends the selection to `booking.holdSeats`; on success the selection is
  emptied and the hold (the mutation's result) shows as a "Your hold" region: its seats, a
  `role="timer"` countdown to the server's `holdExpiresAt` measured on the visitor's clock (the
  server alone decides expiry), and "Release seats" (`booking.releaseHold`; a release refused with
  `HOLD_EXPIRED` drops the hold with the same "Your hold expired" alert). When the countdown
  reaches zero with no checkout in doubt, the hold is dropped from the page with a "Your hold
  expired" alert; nothing is sent, as the server already treats it as expired. A checkout in doubt
  at that moment is reconciled first (see Checkout). A failed background refresh of the seat map
  or the event keeps the last data and the hold controls on screen (with a "could not be
  refreshed" status), so the hold, the checkout and its key survive a transient error; only a
  first load without data shows the error instead. Refusals are told apart by
  `hold-failure.ts`: `SEAT_UNAVAILABLE` (listing the taken seats by section, row and number) and
  `LIMIT_EXCEEDED` both arrive as `CONFLICT` and are split by the domain code that starts the
  error message; `BOOKING_BUSY` is `TOO_MANY_REQUESTS`, `FORBIDDEN` asks the buyer to join the queue
  again (and re-reads `queue.status`), and `NOT_ON_SALE` is `PRECONDITION_FAILED`. Each has its own
  `role="alert"` message. The hold is not kept across a page reload.
- **Checkout** (`components/checkout/checkout-form.tsx`): a "Checkout" form inside the "Your hold"
  region, so the countdown, the release button and the heartbeat stay on while the buyer types.
  `checkoutFormSchema` (zod) trims and validates the email and an optional phone (7 to 15 digits,
  an optional leading `+`, spaces, hyphens and parentheses, at most 32 characters); an empty phone
  is left out of the contact. Field errors show under the input (`aria-invalid`,
  `aria-describedby`) and nothing is sent. A **checkout attempt** is the hold plus the contact it is
  submitted with: its `idempotencyKey` (`crypto.randomUUID()`) is made on the first submit and
  reused for every resubmission of the same contact, so a retry after a network error or lost
  response replays the server's order rather than placing another (ADR 0007). Changing the
  contact, or a new hold (which mounts a new form), starts a new attempt with a new key, so the UI
  itself never sends one key with two different requests. An attempt whose request is in flight
  or whose last answer was ambiguous (network failure or server error) is **unresolved**: at the
  hold's deadline it is replayed once with the same key instead of the hold being declared
  expired, because the server answers a replay with the order it already placed even after the
  hold expired. The order it returns replaces the hold; `HOLD_EXPIRED` ends it; another
  ambiguous answer keeps the form for a manual retry with the same key. Refusals are told apart by
  `checkout-failure.ts`: `HOLD_EXPIRED` (`PRECONDITION_FAILED`) drops the hold with a "Your hold
  expired before your order was placed" alert; `IDEMPOTENCY_KEY_REUSED` (`CONFLICT`, recognised by
  the domain code starting the message) says the checkout was already submitted with different
  details and discards the key, so the next submit is a new attempt; anything else, network
  failures included, asks to try again.
- **Order status** (`components/checkout/order-status.tsx`): once `placeOrder` succeeds the hold
  is dropped and an "Order status" region takes its place on the event page, with a link to
  `/orders/[orderId]`, which renders the same component. It polls `booking.getOrder` every 2 s
  (`ORDER_POLL_MS`) while the order is `PENDING_PAYMENT` and stops at a final state (`CONFIRMED`,
  `CANCELLED`, `EXPIRED`) or a `NOT_FOUND`. It shows the outcome (pending with the payment
  deadline; confirmed with the contact email; cancelled because the payment failed; expired
  because no payment arrived by the deadline), the ticket count and total, and for a final order a
  "Refunds" note. `getOrder` exposes no payment or refund data, so the note states the system's
  guarantee for that state (an extra charge on a confirmed order, or any charge on a cancelled or
  expired one, is refunded automatically with an email when the refund starts and completes),
  not the progress of a particular refund. After an order the hold button does not return until
  the page is reloaded.
- **Heartbeat:** once admitted, the seat map (`seats.map`) and `queue.status` both poll every 3 s,
  through the hold and its checkout too, so the slot is never idle long enough to be reaped and seats taken by
  others appear while the buyer chooses.
- **Admin dashboard** (`components/admin/admin-dashboard.tsx`): polls `admin.snapshot` every 1 s
  (`refetchInterval`, `SNAPSHOT_POLL_MS`) and shows pending payments, an "Orders by status" table
  and a "Seats, queue and metrics per event" table. Polling stops once a poll returns
  `UNAUTHORIZED`, and the page offers a link back to the login. A "Demo event" card has "Run race"
  and "Reset demo" buttons (`useMutation`); the result shows in a `role="status"` line ("Race
  result": successes, seat unavailable, booking busy, duration, winner's correlation id; "Reset
  result": holds, orders and ledger rows deleted, seats freed) and a failure, such as the rate
  limit, in a `role="alert"` line. The next poll shows the new seat state.
- **Server state:** components read `events.list`, `events.get`, `seats.map`, `queue.status`, `booking.getOrder` and `admin.snapshot` through TanStack
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
  deselecting; `clear` empties it once its seats are held. It is a UI rule only: the buyer limit is
  enforced by `holdSeats`. The provider wraps the queue step, seat map and hold controls.
- **shadcn/ui:** `components/ui/` holds the copied `Card`, `Badge` and `Table` sources (Badge
  without `asChild`).
- **Component tests** run in jsdom (`// @vitest-environment jsdom` per file) with Testing Library;
  the event, queue-and-hold and admin tests fake only `fetch` behind a real tRPC client (and the
  clock, with `vi.useFakeTimers({ shouldAdvanceTime: true })`, for the polls and the countdown).

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
