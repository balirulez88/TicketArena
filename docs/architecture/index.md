# Architecture

[← System map](../index.md)

## Module boundaries

| Workspace               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Depends on                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `apps/web`              | Next.js App Router UI and the tRPC API (the only public entry)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `db`, `booking`, `contracts`, `waiting-room` |
| `packages/db`           | Prisma schema, migrations, client factory over the Neon adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                    | (none)                                       |
| `packages/contracts`    | Zod schemas for the event envelope and payloads (`seat.held`, `hold.released`, `hold.expired`, `order.placed`, `payment.succeeded`, `payment.failed`, `order.confirmed`, `order.cancelled`, `order.expired`); `Logger` port, id helpers                                                                                                                                                                                                                                                                            | (none)                                       |
| `packages/booking`      | `BookingService`: `holdSeats` (1–6 seats, buyer limit), `getHold`, `activeHold` (the session's live hold for an event, seats priced), `releaseHold`, `placeOrder`, `getOrder`, `sweepExpired` (sweeper step: holds, then overdue orders), `reconcileRefunds` / `retryRefund` / `refundPendingAgeMax` (refund reconciler, `refund-reconciler.ts`); payment saga handler over the pure `decide` matrix (confirms, or cancels on a final failure); `BookingMetrics` and `SagaMetrics` ports, Redis adapter and reader | `contracts`, `db`                            |
| `packages/waiting-room` | `QueueService` (`join`, `status`, `leave`), `QueueStore` port with a node-redis adapter (atomic Lua scripts, prefixed keys), `AdmissionPolicy` (schedule). See [waiting-room](waiting-room.md)                                                                                                                                                                                                                                                                                                                     | (none)                                       |
| `packages/messaging`    | `MessageBus` port, JetStream adapter (the only `@nats-io/*` importer), outbox relay, consumer runner                                                                                                                                                                                                                                                                                                                                                                                                               | `db`                                         |
| `apps/worker`           | Long-running worker: validates env, ensures the topology, runs the relay, the sweeper, the refund reconciler and consumer runners, serves `/health`; hosts the mock Payment and Notification modules                                                                                                                                                                                                                                                                                                               | `db`, `booking`, `messaging`                 |

New modules are added when a slice needs them, not speculatively.

## Conventions that shape the code

- **Dependency direction:** `apps/*` → `packages/*`, never the reverse. Packages must not read
  `process.env`; configuration is validated at the app boundary (`parseServerEnv`) and injected.
- **tRPC context as the composition root:** infrastructure (clock, db, redis, outbox) enters
  procedures through `TRPCContext`. Procedures never import a client directly, which keeps them
  testable through `createCaller` with fakes at system boundaries only. Booking procedures get
  their service from `bookingServiceFor(ctx)`; `composeBooking` and `connectBooking` turn one
  `BookingTimeouts` value into a `BookingRuntime` (client plus those timeouts). `lazyBooking`
  wraps that in a `LazyBookingRuntime` that builds the client on the first `db()` call, and
  `createTRPCContextFactory(runtime)` sets both `ctx.db()` and the required `ctx.bookingTimeouts`
  from it, so `DATABASE_URL` is read only by procedures that use the database: `health.check`
  and `session.whoami` work without it, and a database procedure fails naming it (see
  [database](../database/index.md#transaction-timeouts-retries-and-booking_busy)).
- **Deep modules, narrow interfaces:** each module exposes a small surface (e.g.
  `join/status/leave` for the waiting room) and hides its storage layout.
- **Packages ship TypeScript source** (`exports` → `src/index.ts`); there is no package build
  step. Turborepo caches `typecheck`, `test`, `build` and `db:generate`.
- **Errors:** validate at boundaries (zod), fail fast with actionable messages, and surface
  domain failures as typed tRPC errors rather than thrown strings. A router maps a domain error
  to a `TRPCError` with the domain error as its `cause`; the error formatter in `server/trpc.ts`
  then adds `data.domainCode` (and, for `SEAT_UNAVAILABLE`, `data.seatIds`) via
  `domainErrorData` (`server/domain-error-data.ts`), so the client tells refusals that share a
  tRPC code apart without reading the message. Codes exposed: `SEAT_UNAVAILABLE`,
  `LIMIT_EXCEEDED`, `BOOKING_BUSY`, `INVALID_SEAT_SELECTION`, `NOT_ON_SALE`, `NOT_FOUND` (a hold),
  `HOLD_EXPIRED`, `HOLD_NOT_ACTIVE`, `HOLD_SEAT_SET_MISSING`, `MIXED_CURRENCY`,
  `IDEMPOTENCY_KEY_REUSED`, and the admin reset's `RESET_BLOCKED` and `NOT_DEMO_EVENT`; the client
  sees `domainCode` as that union, inferred from `AppRouter`. Any other error (a missing
  admission, input validation, an infrastructure cause, or a domain error no router mapped, which
  is an `INTERNAL_SERVER_ERROR`) has no `domainCode`. `data` is only `code`, `httpStatus`, `path`
  and those two fields: tRPC's development `stack` is never sent; the route's `onError` logs it.

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
  `booking.holdSeats` and `booking.placeOrder` resolve `ctx.metrics()` (through `optionalMetrics`)
  and hand it to the booking service; they are the only booking procedures that do, and with the
  metrics unconfigured they book uncounted instead of failing
  ([database](../database/index.md)). The lazy dependencies (`metrics`, `metricsReader`,
  `metricsReset`, `rateLimiter`, `queueStore`) and the logger are one `ContextServices` per process
  (`createContextServices` over `process.env`); `createTRPCContextFactory(booking, services)` lets
  a test build the real context over its own environment.
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
  procedure with `UNAUTHORIZED` unless it is `true`. `ADMIN_PASSWORD` (at least 12 characters) is validated in `parseServerEnv`, and by
  `parseAdminEnv` for the login route only, so it cannot break buyer requests.
- **Login rate limit:** every `POST /api/admin/login`, right or wrong, first takes the admin
  limiter for action `login` (`admin:rate:login`, the same global 1-per-10 s limiter as the demo
  actions, see [Admin API](#admin-api)); only an allowed attempt reads the form and compares the
  password. A refused attempt sets no cookie and redirects (303) to
  `/admin/login?error=rate-limited&retry=<seconds>` with a matching `Retry-After` header; the page
  shows the wait. A limiter that cannot be reached or configured fails closed: the attempt is
  logged and redirected to `/admin/login?error=unavailable`. **Accepted for the demo:** the limit
  is global, not per IP, so an attacker posting one guess every 10 s keeps the real operator's
  login waiting (they can still log in in a gap); per-IP limits would need trusted proxy headers
  and more state.
- **Logout:** `POST /api/admin/logout` (the "Log out" button on `/admin`, a plain form) expires
  the `ta_admin` cookie (`Max-Age=0`, same attributes) and redirects (303) to `/admin/login`; that
  browser then sends no admin cookie, so admin procedures answer `UNAUTHORIZED`. There is no
  server-side session store, so logout **cannot revoke a copied cookie**: a copy stays valid until
  its signed 8-hour expiry (only rotating `SESSION_SECRET` ends it sooner). Accepted for the demo.
- **Known MVP limitation:** clearing cookies yields a new guest session, so per-session guest
  limits (e.g. the 6-ticket limit) can be bypassed until authentication exists.
- **API:** `session.whoami` returns the caller's principal.

## Admin API

`admin.snapshot` (`routers/admin.ts`, `adminProcedure`) returns, at `takenAt`: orders by status
and `pendingPayments` (orders in `PENDING_PAYMENT`; booking never reads the payment schema,
ADR 0009), and per event (all events, by `onSaleAt`) seats by stored status, `queueLength` and
`activeShoppers` (`QueueStore.counts`) and the counters (`hold_ok`, `seat_unavailable`,
`race_lost`, `booking_busy`, `deadlock_retry`, `limit_exceeded`, and the saga's
`late_delivery_refund`) read through `ctx.metricsReader()` (`createRedisBookingMetricsReader` over
the Upstash client's `HGETALL`). Counters are best-effort: when they cannot be read the event's
`metrics` is `null` and the rest is still returned. A `HELD` seat whose hold lapsed counts as held
until the sweeper expires it. `messageHealth.outboxLagMs` is each service outbox's oldest `PENDING`
age, read from Postgres (`admin/outbox-feed.ts`, `measureOutboxLags`); `messageHealth.delivery` is
the worker's `/health` `delivery` block (consumer lag, pending acks, redeliveries, DLQ size and
oldest age), read through `ctx.workerHealth()` (`worker-health.ts`: GET `WORKER_HEALTH_URL` with an
800 ms timeout, validated with zod), and `null` when the URL is unset, the worker cannot be read or
it reports `unavailable`; `refundPendingAgeMaxMs` is `BookingService.refundPendingAgeMax()`. The
figures are separate reads, not one transaction.

**Live feed.** `admin.feed({ cursor?, limit = 50 (1 to 200), correlationId? })` reads the union of
the three service outboxes (`readOutboxFeed`, one indexed branch per table, ADR 0009) in
`(createdAt, id)` order, oldest first. Without a cursor it returns the newest `limit` entries; with
one, only the entries strictly after it. `nextCursor` is the last entry's `(createdAt, id)`, or the
input cursor when nothing new came (`null` for an empty log). Each entry carries `id`, `service`,
`eventType`, `aggregateType`, `aggregateId`, the envelope's `correlationId`, `status` (`PENDING`,
`PUBLISHED` or `FAILED`), `createdAt` and `publishedAt`, never the payload, which holds buyer
contact details. `correlationId` filters to one booking's saga; the dashboard groups by it in the
browser. A row stamped before the cursor but committed after a poll read past it is not shown:
`createdAt` is the writing transaction's start, and the feed is a view for people, not a delivery
log.

**Stuck refunds.** `admin.stuckRefunds({ limit = 100 (1 to 500) })` lists every open refund
obligation (`BookingService.openRefunds`: ledger rows and orphan obligations in `REFUND_REQUESTED`
or `MANUAL_REVIEW`), oldest first request first, each with `paymentId`, `orderId`, amount,
`status`, `refundAttempts`, both request times, `orphan` and `ageMs` (from the first request, as
`refund_pending_age_max`). `admin.retryRefund({ paymentId })` calls `BookingService.retryRefund`
(re-emit through the outbox from `MANUAL_REVIEW`, attempts back to 0, first request time kept); a
payment without an obligation (an `APPLIED` one included) is `NOT_FOUND`, an obligation in another
state `PRECONDITION_FAILED` with domain code `REFUND_NOT_IN_MANUAL_REVIEW`, both naming the payment.

**Dashboard.** `/admin` shows, below the per-event table, a message-health card (outbox lag per
service, consumer table, DLQ size and oldest age, oldest open refund; a note when the NATS figures
are unavailable), the stuck refunds (polled every 5 s, a "Retry refund" button on `MANUAL_REVIEW`
rows only) and the live feed (polled every 1 s after its cursor, the newest 300 entries kept in the
browser, a "Group by correlation id" toggle).

**Demo actions.** Both take no input: the server picks the one event flagged `demo` (anything but
exactly one is `PRECONDITION_FAILED`), so no request can aim them at a real event. Both are limited
to **1 per 10 s per action, globally** (not per session) by `ctx.rateLimiter()`
(`rate-limiter.ts`: `SET admin:rate:<action> 1 NX PX 10000` on the Upstash store, shared by every
instance; a refusal is `TOO_MANY_REQUESTS` naming the seconds to wait from `PTTL`). The limit is
taken first, so a refused call has no effect. The same limiter guards the admin login (action
`login`, see [Identity](#identity)).

- `admin.runRace`: picks the demo event's first `AVAILABLE` seat (none: `PRECONDITION_FAILED`,
  reset first) and has 100 synthetic sessions (fresh random session id = buyer key each) call
  `BookingService.holdSeats` on it concurrently, in-process, bypassing admission by design. Returns
  `buyers`, `successes`, `seatUnavailable`, `bookingBusy`, `otherErrors`, `durationMs` (injected
  clock) and the `winner` (`holdId`, `correlationId`). Only the winner writes an outbox event, its
  normal `seat.held`; that row is the race's entry for the live feed, found by the winner's
  `correlationId`. Counters go to `ctx.metrics()` when configured.
- `admin.resetDemo`: `BookingService.resetEvent(demoId)` (see
  [database](../database/index.md#demo-reset): frees every demo seat and deletes holds without an
  order, keeps every order, order line and ledger row; returns `holdsDeleted`, `ordersKept`,
  `seatsFreed`); `RESET_BLOCKED`/`NOT_DEMO_EVENT` become
  `PRECONDITION_FAILED`. After it commits, the demo event's booking counters
  (`ctx.metricsReset()`, `DEL` of the counter hash) and its waiting-room keys
  (`QueueStore.clearEvent`) are deleted. Postgres goes first because it is the authority; a Redis
  failure fails the call, and repeating it is harmless.

## Catalog API

Routers in `apps/web/src/server/routers/`: `events` (`list`, `get`) and `seats` (`map`), sharing
zod schemas in `catalog-schemas.ts`. They read through `ctx.db()`, a process-wide Prisma client
created on first call from `DATABASE_URL` and `DATABASE_DRIVER` (`neon`, the default, or `pg` for a local
Postgres; `parseDatabaseEnv` validates only these two and refuses a direct `*.neon.tech` host:
the web app must use the `-pooler` endpoint). A missing
event is a `NOT_FOUND` tRPC error. Integration tests run against real Postgres. See
[database](../database/index.md).

## Web UI

Code: `apps/web/src/app/` (routes) and `apps/web/src/components/` (client components).

- **Pages:** `/events` lists events (venue, on-sale date, on-sale status) and links to
  `/events/[eventId]`, which shows the event (venue, on-sale status, a "Prices per section" table),
  the queue step and its seat map. `/admin/login` is a plain HTML form posting to
  `/api/admin/login` that shows the route's `error` (wrong password, the seconds to wait when
  rate-limited, or login unavailable); `/admin` (behind the proxy guard) shows the admin
  dashboard and a "Log out" form posting to `/api/admin/logout`.
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
  `hold-failure.ts` from `error.data` alone, never the message: `domainCode` `SEAT_UNAVAILABLE`
  (listing `data.seatIds` by section, row and number), `LIMIT_EXCEEDED` (both are tRPC
  `CONFLICT`), `BOOKING_BUSY` and `NOT_ON_SALE`; tRPC `FORBIDDEN` (no domain code) asks the buyer
  to join the queue again (and re-reads `queue.status`). Each has its own
  `role="alert"` message. A reload (or a new tab) restores the hold: with no `holdSeats` result
  the page reads `booking.activeHold({ eventId })` once on mount and shows the hold it returns
  with the same countdown, release and checkout, so a live hold that still counts against the
  buyer limit is never hidden. The server decides liveness: a hold that expired (swept or not),
  was released or became an order while the page was closed comes back `null` and nothing is
  shown. A hold the page ends (release, expiry, order) is also cleared from that query's cache,
  so it never reappears.
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
  `checkout-failure.ts` from `data.domainCode` alone: `HOLD_EXPIRED` drops the hold with a "Your
  hold expired before your order was placed" alert; `IDEMPOTENCY_KEY_REUSED` says the checkout was already submitted with different
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
  result": seats freed, holds deleted, orders kept with their payments) and a failure, such as the rate
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
the JetStream topology first, binds the `/health` port (a port in use rejects naming the port, before anything has started), then starts the outbox **relay** (polls every 250 ms, batch of 100) and one
**consumer runner** per registered consumer, and the **sweeper** (`sweeper.ts`: calls
`BookingService.sweepExpired()`, which expires holds and then overdue orders, at start and then 15 s after each sweep ends, `SWEEP_INTERVAL_MS`; a
failed sweep is logged and retried next time; `stop()` cancels the wait at once), the **refund reconciler** (`BookingService.reconcileRefunds()` at start and then 5 min after each pass ends, `RECONCILE_INTERVAL_MS`, on `periodic-loop.ts`; see [database](../database/index.md#refund-reconciler)), the waiting-room **admission ticker** (every 1 s, `ADMIT_INTERVAL_MS`) and **slot reaper** (every 15 s, `REAP_INTERVAL_MS`) in `admission.ts` on the generic `periodic-loop.ts` (same run-then-wait, log-and-retry, prompt-stop behaviour), each a pass over every event (see [waiting room](waiting-room.md#admission-and-slots)), and serves `GET /health` (`{ status: "ok", redis: "ok" | "unavailable" }`, Redis probed with a bounded `PING`, plus the outbox `FAILED` metrics and the broker's delivery figures, see [messaging](../messaging/index.md)). Redis is never awaited at start: its client (`redis.ts`, `createWorkerRedis`) connects on first use with bounded connects and commands, so an outage pauses only the ticker and reaper ([waiting room](waiting-room.md#redis-outage)). Configuration is validated once in
`parseWorkerEnv` (`DATABASE_URL`, `NATS_URL`, `REDIS_URL`, `REDIS_CONNECT_TIMEOUT_MS` default 2000, `REDIS_COMMAND_TIMEOUT_MS` default 1000, `PORT`, `ADMIT_RATE_PER_SECOND` default 10, `MAX_ACTIVE` default 100) and injected. Details: [messaging](../messaging/index.md).

**Start and stop** (`lifecycle.ts`, TD-034, TD-035). If any start step fails after a loop has
started (a consumer's subscribe rejects, say), `startWorker` stops everything already running and
closes the server before the error propagates; that cleanup draws on a `StopBudget`
(`createStopBudget`, default `DEFAULT_SHUTDOWN_DEADLINE_MS`), so a stop that never settles is logged by name
(`worker did not stop within ...`, `pending`) and the start error still propagates. `RunningWorker.components` lists the started parts
by name in stop order (health server, sweeper and refund reconciler, admission ticker and slot reaper, `relay:<service>`,
`consumer:<durable>`); each phase stops together, phases one after another. `main.ts` starts and
stops only through `startWorkerProcess` and `shutdownWorkerProcess`, with `process.exit` injected.
Prisma, Redis and the NATS connection are opened inside `startWorkerProcess`'s `start`, each
registered the moment it exists, so a failed start (the NATS connect included) is logged
(`worker failed to start`), what was opened is closed newest first, and the process exits 1. A
failed start has one budget whose clock starts at the first stop: `startWorker`'s cleanup and the
resource closes both spend from it, so the whole failed-start cleanup ends within 25 s; on SIGTERM or SIGINT every component and then the bus, Redis and Prisma are
stopped, a failing stop is logged with its component and the rest still close (exit 1), and the
whole shutdown is bounded by `DEFAULT_SHUTDOWN_DEADLINE_MS` (25 s, under Fly's 30 s
`kill_timeout`): at the deadline the components still stopping are logged and the process exits 1.
A relay tick cut off this way holds an uncommitted claim; Postgres rolls it back when the process
exits, so its rows stay `PENDING` for the next start.

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
- **Redaction:** buyer contact details (email and phone) never reach a log line. Both app loggers
  (`createWebLogger`, `createWorkerLogger`) pass every serialized line through `redactLogLine`
  (`packages/contracts`, no pino dependency) in pino's `streamWrite` hook, so the rule covers
  child bindings, fields and a serialized error (message, stack, own properties, `cause`) before
  anything is written. Two rules apply at any depth: the value of a key matching `email`,
  `phone` or `recipient` (case-insensitive: `contactEmail`, `contact.phone`, a notification's
  `recipient`) becomes `[Redacted]`, and inside any string an email address or a run of 7 or more
  digits (optional leading `+` and `(`, separated by spaces, dots, dashes or parentheses) not
  touching a word character becomes `[Redacted]`. The value rule covers every format the checkout
  accepts: `booking.placeOrder` validates its contact with `buyerContactSchema`
  (`packages/contracts/src/buyer-contact.ts`: `z.email()`, and a phone of 7 to 15 digits in that
  shape), and a table test runs each accepted format through both. A phone that starts like an
  IPv4 address (four dot-separated groups of 1 to 3 digits) is refused at checkout, because the
  redactor keeps IPv4 addresses readable. Why both: errors are logged whole (`err`) because their name and stack are needed
  to debug, and a Prisma or validation error can embed the buyer's contact in its message (TD-048),
  which no key rule sees. The value rule over-redacts on purpose (a bare 7+ digit number or
  `YYYY-MM-DD` date in a message is lost); UUIDs, ISO timestamps, IP addresses and numeric fields
  survive, so correlation ids stay traceable (a decimal number of 7+ digits is lost too). tRPC
  procedure errors go to the same logger through `onProcedureError` (the API route's `onError`),
  never `console`. Code that logs a new contact
  field under another key name must extend `CONTACT_KEY` in `log-redaction.ts`.

## Children

- [Waiting room](waiting-room.md): queue keys, Lua scripts, ordering invariants, `queue.*` API.
