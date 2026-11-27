# Database

[← System map](../index.md)

## Stack

- **Neon** serverless PostgreSQL. Use the **pooled** connection string at runtime because
  serverless functions open many short-lived connections; the web app's `parseServerEnv` refuses a
  direct Neon host. Migrations (`prisma migrate deploy` in the deploy workflow) and the worker use
  the direct one ([operations](../operations/deployment.md)).
- **Prisma 7** with the `prisma-client` generator (output `packages/db/src/generated/prisma`,
  git-ignored) and an injected driver adapter.
- Configuration in `packages/db/prisma.config.ts`; the schema lives in
  `packages/db/prisma/schema.prisma`; committed migrations in `packages/db/prisma/migrations`.
- `createPrismaClient({ connectionString, driver })` is the only way to build a client. The
  caller injects both, so the package never reads env:
  - `driver: "pg"` (`@prisma/adapter-pg`, TCP): local development, tests, the worker.
  - `driver: "neon"` (`@prisma/adapter-neon`): Vercel functions.
- Tests get a fresh, migrated database per file from `@ticketarena/test-infra`
  (see [workflow](../workflow/index.md#integration-test-infrastructure)). Migrations must
  therefore be committed SQL: the test template is built by applying them in order.

## Tables

All tables live in the `public` schema (`multiSchema` with `schemas = ["public"]`; every model and
enum carries `@@schema("public")`).

| Table                       | Purpose                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outbox_events`             | Transactional outbox: integration events written in the business TX                                                                                                                                                                                                                                                                                          |
| `outbox_event_history`      | Append-only audit of outbox rows: permanent publish failures and status changes (see below)                                                                                                                                                                                                                                                                  |
| `processed_messages`        | Consumer dedupe checkpoint: `(consumer, messageId)` primary key, written in the handler's TX (ADR 0007)                                                                                                                                                                                                                                                      |
| `venues`                    | Seeded venues                                                                                                                                                                                                                                                                                                                                                |
| `sections`                  | Priced area of a venue: `priceMinor` (integer minor units), `currency` `EUR`                                                                                                                                                                                                                                                                                 |
| `rows`                      | Row label within a section                                                                                                                                                                                                                                                                                                                                   |
| `events`                    | `onSaleAt`, `queueOpensAt`, `queueClosesAt`, `demo` flag; unique `name`                                                                                                                                                                                                                                                                                      |
| `seats`                     | **Per event** seat: `status` `AVAILABLE`, `HELD`, `IN_CHECKOUT` or `SOLD`, `holdId?`, `claimBuyerKey?`                                                                                                                                                                                                                                                       |
| `holds`                     | A buyer's hold: `buyerKey`, `status` `HELD`, `ORDERED`, `RELEASED` or `EXPIRED`, `holdExpiresAt`, `correlationId`                                                                                                                                                                                                                                            |
| `orders`                    | One per hold: contact, `totalMinor`, `status`, fixed `paymentDeadline`, unique `(sessionId, idempotencyKey)`                                                                                                                                                                                                                                                 |
| `order_lines`               | Seat prices copied at placement                                                                                                                                                                                                                                                                                                                              |
| `order_payments`            | Ledger of captured money: `paymentId` PK, `amount`, `capturedAt`, `disposition` (`APPLIED` for a confirmed order; `REFUND_REQUESTED` for a refund obligation, with `refundReason`, `refundRequestedAt`, `refundLastRequestedAt`, `refundAttempts`; `MANUAL_REVIEW` once the reconciler gives up; `REFUNDED` once `payment.refunded` closes it)               |
| `orphan_refund_obligations` | Refund obligation for a capture whose order booking does not have (`unknown_order`): `paymentId` PK, `orderId` (no FK), `amount`, `currency`, `capturedAt`, `correlationId`, `status` (`REFUND_REQUESTED` → `REFUNDED` \| `MANUAL_REVIEW`), `refundRequestedAt`, `refundLastRequestedAt`, `refundAttempts`. Outlives its outbox row, which retention deletes |

Catalog data is seeded, never edited through the API. `seedCatalog(prisma, now)`
(`packages/db/src/seed.ts`) only inserts
missing rows, so re-running it keeps seat state. Seats are unique on `(eventId, rowId, number)`
and indexed on `(eventId, status)` and on `holdId`. `venues.name` is unique, so `seedCatalog` upserts venues
and concurrent seed runs leave one row per venue. The demo event goes on sale one day before the
seeding instant (its queue window has closed), so holds and `admin.runRace` work at once; the
other events go on sale 14 and 30 days after it. A database seeded before this rule keeps its
demo event's later `onSaleAt` (re-running the seed never updates a row); reset the database to
pick it up.

`seedCatalog` is not part of the runtime entry point (`@ticketarena/db`, `src/index.ts`), so no
request path can reach it: tests and the seed command import it from `@ticketarena/db/seed`
(`packages/db/src/entry-points.test.ts`). The seed command is
`DATABASE_URL=<url> pnpm --filter @ticketarena/worker db:seed` (`apps/worker/src/seed-main.ts`):
`parseSeedEnv` validates only `DATABASE_URL` and the command seeds over the `pg` driver, then
disconnects. It lives in the worker because packages never read the environment
(`packages/db/src/no-process-env.test.ts` fails on any `process.env` read under `packages/*/src`
outside tests and test-infra); `apps/worker/src/seed-main.test.ts` runs it against the test
database.

### Duplicate venue merge

The old check-then-create seed could insert a venue twice, which `venues_name_key` would refuse.
Migration `20261030025000_merge_duplicate_venues` runs just before the one that creates that index
and merges such duplicates; on a database without duplicates it changes nothing. The rule:

- Per venue name, the venue with the lowest `id` survives; the others are deleted after their
  references move to it.
- Their events point at the surviving venue.
- A duplicate's section moves to the surviving venue, unless a section of that name is already in
  the group: then the sections merge into one (the surviving venue's own, else the lowest `id`).
- Same-name sections merge only if they all have the same `priceMinor` and `currency`, because a
  seat's price is its section's and a merge would reprice existing seats on the seat map and at
  checkout. If any group differs, the migration aborts before it changes a row, with an error that
  lists each conflicting venue, section name and every section's `id`, price and currency. Fix:
  give the listed sections the same `priceMinor` and `currency`, or rename all but one of them,
  then rerun `prisma migrate deploy`.
- Rows of merged sections move the same way: a row whose label the merged section already holds
  merges into one row (the surviving section's own, else the lowest `id`), and its seats move to
  that row. No seat is deleted; two seats of one event on one merged row and number would abort the
  migration on `seats_eventId_rowId_number_key`, which seeded data cannot produce.

`packages/db/src/venue-merge-migration.test.ts` migrates databases to just before this step,
inserts two same-name venues with sections, rows, events and seats, and applies the remaining
migrations: with matching section prices it checks the merged result and that every seat keeps
its price and currency; with a differing price or currency it checks the abort and that nothing
changed.

### Indexes and unique constraints

`packages/db/src/docs.test.ts` fails when a migration creates one that is not named here.

| Name                                          | On                                                                                     | Why                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `venues_name_key`                             | `venues(name)` unique                                                                  | Seed upserts; one row per venue                  |
| `sections_venueId_name_key`                   | `sections(venueId, name)` unique                                                       | Seed upserts                                     |
| `rows_sectionId_label_key`                    | `rows(sectionId, label)` unique                                                        | Seed upserts                                     |
| `events_name_key`                             | `events(name)` unique                                                                  | Seed upserts                                     |
| `seats_eventId_rowId_number_key`              | `seats(eventId, rowId, number)` unique                                                 | One seat per event position                      |
| `seats_eventId_status_idx`                    | `seats(eventId, status)`                                                               | Seat map and availability                        |
| `seats_holdId_idx`                            | `seats(holdId)`                                                                        | `getHold` and hold lifecycle updates (FK lookup) |
| `holds_eventId_buyerKey_idx`                  | `holds(eventId, buyerKey)`                                                             | Per-buyer lookups                                |
| `orders_holdId_key`                           | `orders(holdId)` unique                                                                | A hold yields at most one order                  |
| `orders_sessionId_idempotencyKey_key`         | `orders(sessionId, idempotencyKey)` unique                                             | Idempotent `placeOrder`                          |
| `order_lines_orderId_seatId_key`              | `order_lines(orderId, seatId)` unique                                                  | One line per seat                                |
| `order_payments_orderId_idx`                  | `order_payments(orderId)`                                                              | Ledger lookup per order (FK)                     |
| `order_payments_orderId_applied_key`          | `order_payments(orderId)` unique, partial                                              | At most one `APPLIED` payment per order          |
| `order_payments_open_refund_idx`              | `order_payments(refundLastRequestedAt)`, partial (`REFUND_REQUESTED`, `MANUAL_REVIEW`) | Reconciler scan and `refund_pending_age_max`     |
| `outbox_events_status_createdAt_idx`          | `outbox_events(status, createdAt)`                                                     | Relay polling                                    |
| `outbox_events_aggregateType_aggregateId_idx` | `outbox_events(aggregateType, aggregateId)`                                            | Aggregate lookup                                 |
| `outbox_event_history_outboxId_id_idx`        | `outbox_event_history(outboxId, id)`                                                   | History of one outbox row, in order              |

Booking: `booking.holdSeats` (1–6 seats of one event, all or nothing), `booking.getHold` (owner only, else
`NOT_FOUND`) and `booking.activeHold({ eventId })` delegate to `BookingService` (`packages/booking`). `holdSeats` first requires a valid
admission token for the session and the input `eventId` (`admittedProcedure`, else tRPC
`FORBIDDEN` with nothing written; see [waiting room](../architecture/waiting-room.md#admission-token)). `holdSeats` rejects an empty, duplicated or longer-than-6 `seatIds` list with `INVALID_SEAT_SELECTION` (tRPC
`BAD_REQUEST`) before writing. Before the event's `onSaleAt` it refuses with `NOT_ON_SALE` (tRPC
`PRECONDITION_FAILED`, naming the on-sale time) and writes nothing, whatever admission the buyer
holds (defence in depth behind the waiting room, ADR 0008); an unknown event passes this check and
its seats are `SEAT_UNAVAILABLE`. It then takes a lock-free snapshot read (`seats` joined to `holds`) and
refuses with `SEAT_UNAVAILABLE` any seat visibly `SOLD`, `IN_CHECKOUT` or `HELD` with an unexpired hold,
without locking; the snapshot is advisory and only ever refuses, so the locked step decides
success (ADR 0005). Otherwise it runs one transaction: first the buyer lock
(`pg_advisory_xact_lock` on a hash of `eventId:buyerKey`), then `SELECT … FOR UPDATE` on the seats
`ORDER BY id`, then `T = clock.now()` read **after** the lock, then the `holds`
row (`holdExpiresAt = T + 10 min`, fresh `correlationId`), the seat set `HELD`, and a `seat.held`
row in `outbox_events` whose `payload` is the full event envelope and whose `id` is the envelope
`id`. Buyer limit: under the lock the transaction counts the buyer's seats of the event with
`claimBuyerKey = buyerKey` that are `IN_CHECKOUT`, `SOLD` or `HELD` with an unexpired hold (each
seat once); if that plus the request exceeds 6 (`MAX_SEATS_PER_BUYER`) it rolls back with
`LIMIT_EXCEEDED` (tRPC `CONFLICT`) and counts `limit_exceeded`, so overlapping requests never leave
a partial hold. Lazy expiry: a seat is free iff `AVAILABLE`, or `HELD` by a hold with
`holdExpiresAt <= T` (the hold's expiry is read by a fresh, unlocked statement after the seat
locks); such a seat is taken over by the new hold while the old hold stays `HELD` until the sweeper
expires it. `IN_CHECKOUT` and `SOLD` are never free. Any other seat fails with `SEAT_UNAVAILABLE`
(tRPC `CONFLICT`) naming its id.
No SQL `now()`; the `Clock` is injected.

`booking.activeHold({ eventId })` (public, no admission needed: a hold outlives it) returns the
latest `holds` row of the event with `sessionId` and `buyerKey` of the caller, `status = HELD` and
`T < holdExpiresAt`, shaped as `holdSeats` returns it plus `seats` (each seat still carrying the
hold's id, with its section's `priceMinor` and `currency`), or `null`. Matching on `sessionId` as
well means another session of the same signed-in user never sees it; an expired hold the sweeper
has not reached yet is `null`, as on every other path. A read only: it writes nothing.

Metrics: an optional `BookingMetrics` port counts `hold_ok`, `limit_exceeded`, `seat_unavailable` (snapshot refusals,
and refusals under the lock of seats nobody changed since the snapshot, such as a seat outside
the event) and `race_lost` (refused under the lock because a refused
seat's status or hold changed after the snapshot read it) per event, plus `booking_busy` and
`deadlock_retry` (see Transaction timeouts below); the dashboard reader reads every counter but
`deadlock_retry`, an operational signal rather than a booking outcome. Counters are bumped
after the outcome is decided, fire-and-forget; a failure is logged and never fails a booking. The
Redis adapter (`createRedisBookingMetrics`) keeps one hash per event,
`booking:metrics:<eventId>`, with the metric as field. Seat state is never decided by Redis.

In production the web app counts into Upstash: `booking.holdSeats` and `booking.placeOrder` take
their `BookingMetrics` from the context (`ctx.metrics()`: `createRedisBookingMetrics` over the
Upstash REST client, built once per process from `UPSTASH_REDIS_REST_*`), so each increment is one
`HINCRBY booking:metrics:<eventId> <metric> 1`. No other booking procedure resolves it. What each
operation sends:

| Operation    | Counters sent                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `holdSeats`  | `hold_ok` after commit; or one refusal (`seat_unavailable`, `race_lost`, `limit_exceeded`); `deadlock_retry` per retried attempt; `booking_busy` on saturation or exhausted retries |
| `placeOrder` | nothing on success; `deadlock_retry` per retried attempt; `booking_busy` on saturation or exhausted retries (key `unknown` before the hold is read)                                 |

These counts are best-effort. A failed increment (an Upstash error, a refused connection, the
client's 2 s request timeout) is logged once with its metric (`metric failed`) and the booking
returns its normal result without waiting for it. Missing or invalid Upstash variables leave the
booking uncounted (logged once at the boundary) rather than failing it. Because the increment is
not awaited, a request the platform cuts short after its response (a serverless function frozen or
stopped) may lose an increment; the counters are for the dashboard, never for decisions.
Tests: `apps/web/src/server/routers/booking-metrics.test.ts`.

Orders: `booking.placeOrder` (no admission required) and `booking.getOrder` (owner only, else
`NOT_FOUND`). `placeOrder` runs one transaction with the lock order buyer lock (same key as `holdSeats`, taken after an unlocked read of the hold's event), hold `FOR UPDATE`, seats
`ORDER BY id FOR UPDATE`, then `T = clock.now()`. It requires a `HELD` hold owned by the caller's
`BuyerKey` (else `NOT_FOUND`; an `EXPIRED` hold, i.e. one the sweeper got first, is `HOLD_EXPIRED`), `T < holdExpiresAt` (else `HOLD_EXPIRED`, tRPC
`PRECONDITION_FAILED`) and every seat still `HELD` with this `holdId`; the expected seat set is
read from the hold's `seat.held` outbox event, so a seat that lost its `holdId` fails with
`SEAT_UNAVAILABLE`. A non-`HELD` hold is refused (`HOLD_NOT_ACTIVE`) before the event is read, and a
missing `seat.held` event is `HOLD_SEAT_SET_MISSING` (`CONFLICT`). Lines, total and the `IN_CHECKOUT`
update use exactly that seat set; seats of mixed currencies fail with `MIXED_CURRENCY`. It then writes the `orders`
row (`PENDING_PAYMENT`, `paymentDeadline = T + 5 min`, the hold's `correlationId`) with
`order_lines` copying seat prices, sets the hold `ORDERED` and seats `IN_CHECKOUT`, and writes an
`order.placed` outbox row. Idempotency (ADR 0007): `requestHash` is the SHA-256 of the canonical
request (hold id, email, phone or null, in that order), so equal requests hash equally whatever
their object shape. A repeated `(sessionId, idempotencyKey)` with the same hash returns the stored
order, checked before any hold logic so a replay succeeds even after the hold expired; the same key
with a different hash fails with `IDEMPOTENCY_KEY_REUSED` (tRPC `CONFLICT`). A concurrent duplicate
that waited on the hold lock finds the winner's order inside its transaction; one that still loses
the unique-constraint race (`P2002`) rolls back and re-reads the winner's order. Either way one
order, one set of lines and one `order.placed` row exist, and only the request that created the
order logs "order placed" (the transaction returns a result tagged `created` or `replayed`). `holdId` is unique on `orders`, so a hold yields at most one order.

Releasing: `booking.releaseHold` (owner only, else `NOT_FOUND`) gives back a `HELD` hold while
`T < holdExpiresAt`. Its refusals match `placeOrder`'s: a hold the sweeper already moved to
`EXPIRED`, or a `HELD` one with `holdExpiresAt <= T` (not yet swept), is `HOLD_EXPIRED` (tRPC
`PRECONDITION_FAILED`); any other status (`RELEASED`, `ORDERED`) is `HOLD_NOT_ACTIVE` (tRPC
`CONFLICT`). An expired, unswept hold is left `HELD` with no `hold.released` row, so the sweeper
frees its seats and writes `hold.expired`; the seats end up `AVAILABLE` either way. One transaction with the same lock order as `placeOrder` (buyer lock, hold
`FOR UPDATE`, then the seats still `HELD` with this `holdId` `ORDER BY id FOR UPDATE`) sets the
hold `RELEASED`, sets exactly those seats `AVAILABLE` with `holdId` and `claimBuyerKey` cleared (a
seat taken over by another hold is left alone), and writes a `hold.released` outbox row. The
returned hold view lists the freed seats; the seats are holdable by anyone as soon as it commits.
Releasing a hold does not end shopping: the buyer's waiting-room slot is untouched (slot logic
arrives in ticket 30; only `placeOrder`, leaving or reaping end it).

Expiry: one `T` per transaction and one rule everywhere, a hold is valid iff `T < holdExpiresAt`
(snapshot, lazy takeover, buyer limit, `placeOrder`, `releaseHold`, sweeper). `BookingService.sweepExpired()` is
the sweeper's step: per transaction (batches of 100, repeated until a short batch) it reads `T`,
claims `HELD` holds with `holdExpiresAt <= T` `FOR UPDATE SKIP LOCKED`, locks the seats still `HELD`
with those `holdId`s `ORDER BY id FOR UPDATE`, sets the holds `EXPIRED` and those seats `AVAILABLE`
(`holdId` and `claimBuyerKey` cleared; a seat taken over lazily is left alone), and writes one
`hold.expired` outbox row per hold. A hold `placeOrder` has locked is skipped; one it has converted
no longer matches `HELD`, so checkout and the sweeper never both win (the hold row lock serializes
them). The same call then expires overdue orders: per transaction (batches of 100) it reads `T`,
claims `PENDING_PAYMENT` orders with `paymentDeadline + 60 s` (settlement grace) `<= T`
`FOR UPDATE SKIP LOCKED`, locks their `IN_CHECKOUT` seats (by the order's `holdId`)
`ORDER BY id FOR UPDATE`, sets the orders `EXPIRED` and those seats `AVAILABLE` (`holdId` and
`claimBuyerKey` cleared, so the buyer limit drops) and writes one `order.expired` outbox row per
order with the contact. Invariant: `IN_CHECKOUT` seats are freed only in the transaction that ends
the checkout; lazy expiry and the hold sweeper never free them, so checkout outlives the hold's own
expiry (AT-10). The only other such transactions are the payment saga's cancellation on a final payment failure (order `CANCELLED`, seats `AVAILABLE`, `order.cancelled`) and its expiry on a capture after the deadline (order `EXPIRED`, seats `AVAILABLE`, `order.expired`, a `REFUND_REQUESTED` ledger row and `payment.refund_requested`); the late payment never reclaims the seats. An order the payment saga has locked is skipped and re-checked next sweep. The hold
stays `ORDERED`. `apps/worker` runs it every 15 s.

### Transaction timeouts, retries and `BOOKING_BUSY`

Settings (ADR 0005, `packages/booking/src/booking-transaction.ts`): every `holdSeats` and
`placeOrder` transaction attempt starts with `set_config(..., true)` (`SET LOCAL`) for
`lock_timeout` 3s and `statement_timeout` 5s, so the pooled connection is back at the server
defaults after it. One exported value, `DEFAULT_BOOKING_TIMEOUTS` (`lockTimeoutMs`,
`statementTimeoutMs`, `retries` 3), drives both those values and the Prisma transaction options
`bookingTransactionOptions(timeouts)`. The web app's `composeBooking` (`apps/web/src/server/trpc.ts`)
and `connectBooking` build one `BookingRuntime` (the Prisma client plus that same value); the
request context takes `ctx.db` and the required `ctx.bookingTimeouts` from it, and the booking
services (`bookingServiceFor(ctx)`) always run `ctx.bookingTimeouts`. `createPrismaClient` applies `acquireTimeoutMs` to
both drivers (`connectionTimeoutMillis` of the `pg` pool and of the Neon pool); the web client uses
`BOOKING_ACQUIRE_TIMEOUT_MS` = 3 s. For `pg` it builds the pool itself and hands it to the adapter
(which ends it on `$disconnect`), so a test can read the pool's `waitingCount` through
`observePool` and prove a caller is queued instead of guessing with a round trip.

Budget: the Prisma interactive-transaction `timeout` is (lock waits on the longest path, 3 for
`placeOrder`: buyer advisory lock, hold row, seat rows) × `lock_timeout` + `statement_timeout` +
a 1 s margin (`TRANSACTION_MARGIN_MS`, for round trips and the commit) = 3 × 3 s + 5 s + 1 s = 15 s.
`maxWait` equals the acquire timeout (3 s): a transaction waits for its connection no longer than
any other read, and either timeout is saturation.

Retries: Postgres `40P01` (deadlock), `55P03` (lock timeout) and `40001` (serialization failure)
re-run the whole transaction, up to 3 retries; each retry counts `deadlock_retry` and logs
"booking transaction retried" with the SQLSTATE. Any other database error is not retried. Before
each retry the service waits a jitter delay of `20 + floor(random × 180)` ms, i.e. at least
20 ms and below 200 ms (`RETRY_JITTER_MIN_MS`, `RETRY_JITTER_MAX_MS`), from an injected random
source through an injected timer seam (`random`, `delay` in `BookingServiceDeps`). Exhausted
retries fail with `BookingBusyError` (`BOOKING_BUSY`, tRPC `TOO_MANY_REQUESTS`) and count
`booking_busy`.

Worst case from the first attempt to `BOOKING_BUSY` (`worstCaseBookingBusyMs()`): every attempt
may wait `maxWait` to start and then run up to its transaction timeout, and every retry first
waits at most the maximum jitter: (retries + 1) × (`maxWait` + 3 × `lock_timeout` +
`statement_timeout` + margin) + retries × maximum jitter = 4 × (3 s + 3 × 3 s + 5 s + 1 s) +
3 × 200 ms = **72.6 s** for the production defaults (lock 3 s, statement 5 s, 3 retries, `maxWait`
3 s, maximum jitter 200 ms). The reads before the transaction (event, snapshot, idempotency
replay, hold owner) can each add up to the acquire timeout on top.

Saturation is `BOOKING_BUSY` (tRPC `TOO_MANY_REQUESTS`) and counts `booking_busy`, for both
`holdSeats` and `placeOrder`, and for every read `placeOrder` makes outside its transaction too
(the idempotency replay, the hold-owner read and the re-read after a duplicate key). Saturation is:
a pool acquire timeout (pg-pool's message `timeout exceeded when trying to connect`), a transaction
start timeout (`P2028` with Prisma's message `Unable to start a transaction in the given time`), and
a statement cancelled by `statement_timeout` (below). These are not retried. A `placeOrder` refused
before it has read its hold does not know the event yet: its `booking_busy` goes to the metrics key
`eventId` = `"unknown"` (Redis hash `booking:metrics:unknown`); event ids are UUIDs, so it never
collides with an event.

Not saturation, surfaced unchanged (tRPC `INTERNAL_SERVER_ERROR`): a `P2028` for a transaction
that outlived its own runtime `timeout` (its work may have committed, so it is never retried) or
that was already closed; a connection that never opens (`Connection terminated due to connection
timeout`, pg-pool and the Neon pool alike), which counts nothing; any other database error.

`57014` rule: Postgres raises SQLSTATE `57014` both for a statement cancelled by
`statement_timeout` and for one cancelled by another session (`pg_cancel_backend`). The first is
`BOOKING_BUSY` after one attempt and counts `booking_busy`; the second is an internal error (the
service rethrows the Prisma error, which keeps `57014` in its cause chain, and the router returns
`INTERNAL_SERVER_ERROR`). Only the server message tells them apart: `originalMessage` =
`canceling statement due to statement timeout` versus `canceling statement due to user request`.

Classifier (`packages/booking/src/transaction-errors.ts`, not exported from the package entry) reads
only: the Prisma error's `meta.driverAdapterError.cause.originalCode` (SQLSTATE) and
`.originalMessage`, present alike for raw queries (`P2010`) and model queries (`P2034` for
`40001`/`40P01`, `P2039`, `P2002`, ...); `code` `P2028` with the start-timeout message; and the
pool's acquire-timeout `message`. The two pinned driver messages and the `57014` messages are
coupled to pg-pool, Prisma and Postgres wording; the real-driver tests in
`transaction-busy.test.ts` and `connect-timeout.test.ts` pin them, so a reworded message fails a
test instead of silently changing behaviour. The SQLSTATE fields are the same for both drivers:
`convertDriverError` in `@prisma/adapter-pg` 7.10.1 and `@prisma/adapter-neon` 7.10.1 (with
`@neondatabase/serverless` 1.2.0) wraps a Postgres error identically as `{ originalCode,
originalMessage, ...mapDriverError(error) }` with the same `kind` per SQLSTATE; `adapter-pg` adds
only the socket and TLS cases before it (and differs only in how it parses constraint and column
names for `23505`/`42703`, which the classifier does not read).

Tests fill a one-connection pool with `occupy` (`@ticketarena/booking/testing`, never the package's
main entry): it resolves after a query has run inside the occupying transaction, and retries any
failure before that point, up to a deadline, because a short acquire timeout also bounds opening
the pool's first connection. The same subpath holds every other helper the real-Postgres tests
share, so no test file keeps its own copy:

- Lifecycle: `testClients(database)` gives each test its own client (`db()`), plus any extra
  clients it `open(options)`s, and disconnects them all after the test; `withClient` scopes a
  client to one piece of work (seeding in `beforeAll`). `bookingTestBed(database)` seeds the
  catalog and adds `service(deps)`, `at(when)` and `freeSeats(count)`. No client outlives a test.
- Fixtures: `NOW`, `buyer(n)`, `freshBuyer()`, `freeSeats`, `recordingMetrics`, `failureOf`, and
  `slowStart` (the one injected delay, of an occupier's start).
- Synchronisation by Postgres state, never by time: `block(db, lock)` holds `buyerLock(...)` or
  `rowLock(table, ids)` in a blocker session until `release()`, with named deadlines on taking
  and on holding the lock, and reports the blocker's own failure on release;
  `waitUntilBlocked`/`blockedBy` read `pg_blocking_pids`; `waitForPg(what, probe, { against })`
  polls a condition to a named deadline and stops at once when the call under test settles;
  `settledUnlessBlocked` tells a call that finished from one Postgres shows blocked; `latch()`.
- `withTrigger(db, spec, body)` installs a uniquely named trigger (with an optional scratch table
  and a call counter that survives rollback) and drops every object it made, even when the body
  throws.

`packages/db` cannot import these (booking depends on it), so `seed.test.ts` opens and
disconnects a client inside each test. `catalog.test.ts` and `seed.test.ts` also run with their
tests shuffled under a fixed seed (a `*-shuffled` Vitest project in each package's config), which
proves they do not depend on each other's writes.

### Demo reset

`BookingService.resetEvent(eventId)` frees the demo event so the race can run again, without ever
deleting financial history. One transaction: it refuses any event whose `demo` flag is not set (`NOT_DEMO_EVENT`), then
locks the event's `holds`, their `orders` and its `seats` (each `ORDER BY id FOR UPDATE`, in that
order, which no booking path inverts: `placeOrder` locks a hold before seats, the saga and sweeper
an order before seats). It is `RESET_BLOCKED` while an order is `PENDING_PAYMENT` or a refund
obligation is open (an `order_payments` row `REFUND_REQUESTED` or `MANUAL_REVIEW`), and also when a
seat carries a hold it did not lock (a booking committed mid-reset); blocked means nothing
changed. Otherwise it sets every seat not plain `AVAILABLE` back to `AVAILABLE` (`holdId`,
`claimBuyerKey` cleared) and deletes only the holds that never became an order; it returns
`holdsDeleted`, `ordersKept` and `seatsFreed`. **Kept:** every demo `orders` row (whatever its
status), its `order_lines`, its `order_payments` ledger rows and the hold it was placed from,
unchanged. A kept order's lines still name seats that are now free and may be sold again; they are
history only, since no live check reads them (seat state lives on `seats`, and the saga locks an
order's seats only while it is `PENDING_PAYMENT`, which a reset never leaves behind). The per-buyer
limit counts a buyer's claimed seats (`claimBuyerKey`), so after a reset it counts nothing from
before. Also kept on purpose: `public.outbox_events` (history the relay may
still be publishing; a new hold has a new id, so `placeOrder`'s `seat.held` lookup is unaffected),
`processed_messages`, and everything in the `payment` and `notification` schemas (ADR 0009: no
cross-schema deletes). Only `admin.resetDemo` calls it. `reset-event.test.ts` races the reset
against `holdSeats`, `placeOrder`, the payment saga and both sweepers on real Postgres to pin these
guarantees.

Because orders survive a reset, a late or duplicate `payment.succeeded` for a demo order that was
`EXPIRED`, `CANCELLED` or `CONFIRMED` before it finds its order and follows the saga's normal rule
for that state: a capture not yet in the ledger becomes a refund obligation (`REFUND_REQUESTED`
ledger row plus `payment.refund_requested`), a redelivery of a known `paymentId` is a no-op, and
neither changes a seat, so seats a new buyer holds after the reset are
not reclaimed. The `unknown_order` refund (an order with no row at all) remains as a safety net
for an order that truly does not exist; a reset no longer creates that case.

That refund's obligation lives in `orphan_refund_obligations`, because the ledger's foreign key
to `orders` cannot hold it. The primary key on `paymentId` keeps one obligation per payment even
for concurrent duplicate captures, and the row carries everything a re-emitted
`payment.refund_requested` needs (`unknown_order` requests have no contact), so deleting its
outbox row loses nothing. Migration `20261127000000_orphan_refund_obligations` backfilled one open
obligation per `paymentId` from the existing `unknown_order` outbox rows, taking the earliest
request's `occurredAt` as `capturedAt` and `refundRequestedAt` (the request carries no capture
time, so this is a historical proxy for it: the saga's T, never before the capture). A backfilled
obligation whose refund had already completed stays `REFUND_REQUESTED`, since booking cannot see
Payment's schema; the reconciler's re-emit refunds nothing twice (`payment.refunds` is unique per
`paymentId`), and Payment answers it by announcing the executed refund again, which closes it as
`REFUNDED` (see [Refund reconciler](#refund-reconciler)). `unknown_order` requests the previous
worker writes after the migration are caught up by the reconciler
([refund cutover](../operations/deployment.md#refund-cutover)).
`packages/db/src/orphan-refund-backfill-migration.test.ts` pins the backfill.

### Refund reconciler

No refund obligation is forgotten (spec: Refund obligations and reconciliation). The worker calls
`BookingService.reconcileRefunds()` every 5 minutes (`packages/booking/src/refund-reconciler.ts`);
the limits are injectable (`RefundReconcilerLimits`, defaults `DEFAULT_REFUND_RECONCILER_LIMITS`:
stale after 10 min, 3 re-emits, batches of 100). A pass covers the ledger (`order_payments`) and the
orphan refund obligations the same way, after a **cutover catch-up** that completes refund
obligations a previous worker wrote in its own shape
([refund cutover](../operations/deployment.md#refund-cutover)):

- **Stale** means `REFUND_REQUESTED` with `refundLastRequestedAt <= T - 10 min`. The age is taken
  from the **last** request (the saga's first request, a re-emit, or an operator's retry), so
  re-emits come at least 10 minutes apart whatever the pass interval, and Payment always has 10
  minutes to answer each one.
- A stale obligation with fewer than 3 re-emits gets its `payment.refund_requested` re-emitted, and
  `refundAttempts + 1`, `refundLastRequestedAt = T`, in **one transaction** with the outbox row
  (ADR 0003). The request is rebuilt from the row alone: a new event id, the original
  `paymentId`, `orderId`, `amount`, `currency` and `refundReason` (`unknown_order` for an orphan),
  the order's contact and `holdId` (none for an orphan), the payment's correlation id (the order's,
  or the orphan's `correlationId`), `causationId: null`, so it does not need the original outbox row
  that retention deletes.
- A stale obligation that already has 3 re-emits moves to `MANUAL_REVIEW` instead and emits
  nothing (logged at `warn`). So the third re-emit, too, gets its 10 minutes before a human is asked.
  The reconciler never touches `MANUAL_REVIEW` again; `payment.refunded` still closes it to `REFUNDED`.
- **Concurrency:** each batch claims rows `ORDER BY paymentId … FOR UPDATE SKIP LOCKED` (only the
  obligation row; the order is read unlocked, its columns never change), so two workers split the
  rows and never re-emit one twice or wait on each other, and a row committed by one pass no longer
  matches for the other. Only the saga's `payment.refunded` update also writes these rows, and it
  accepts `REFUND_REQUESTED` and `MANUAL_REVIEW` alike, so whichever commits first, the obligation
  ends `REFUNDED`. `refund-reconciler.test.ts` races two passes on real Postgres.

`BookingService.retryRefund(paymentId)` (the operator's "retry refund"; ticket 36 exposes it as
`admin.retryRefund`) locks the payment's obligation, ledger first and then orphan, and moves
`MANUAL_REVIEW` → `REFUND_REQUESTED`, re-emits the request and resets `refundAttempts` to 0 with
`refundLastRequestedAt = T`, in one transaction, so the reconciler gives it a full 3 re-emits
again. It is `NOT_FOUND` (`RefundObligationNotFoundError`) for a payment with no refund obligation
(an `APPLIED` ledger row is a payment, not a refund obligation, so it is `NOT_FOUND` too) and
`REFUND_NOT_IN_MANUAL_REVIEW` (`RefundNotInManualReviewError`, nothing changed) for any other
state; it returns the obligation as it now is, with its first `refundRequestedAt` kept.

`BookingService.refundPendingAgeMax()` is `refund_pending_age_max` for the dashboard: ms from the
first request (`refundRequestedAt`, never moved by a re-emit) of the oldest open obligation
(`REFUND_REQUESTED` or `MANUAL_REVIEW`, both tables) to `T`, 0 when none is open.

**A lost confirmation is recovered.** Payment answers every request, a duplicate too: a re-emit
for a refund it already executed refunds nothing twice and announces that refund again
(`payment.refunded` with the executed refund's `refundedAt`, amount and currency, a new event id,
through its outbox in the same transaction). So an obligation whose `payment.refunded` was lost, or
never closed it (a backfilled orphan obligation whose refund had completed), is `REFUNDED` after
the next re-emit; `apps/worker/src/refund-recovery-flow.test.ts` loses the first confirmation and
shows each kind converging with one refund. `MANUAL_REVIEW` is left for a Payment that does not
answer at all. Each re-emit and re-announcement has a new event id; Notification keys refund
messages by `paymentId` and template, so the buyer still gets one `refund-initiated` and one
`refund-completed` per channel (see [messaging](../messaging/index.md#notification)).

Migration `20261128000000_refund_reconciler` added `refundReason` and `refundLastRequestedAt` to
`order_payments`, `correlationId`, `refundAttempts` and `refundLastRequestedAt` to
`orphan_refund_obligations`, and `MANUAL_REVIEW` to the orphan status. It backfilled the reason and
the correlation id from the payment's earliest `payment.refund_requested` outbox row (a ledger row
without one takes the reason its order's status implies; an orphan without one takes its
`paymentId` as correlation id) and `refundLastRequestedAt` from `refundRequestedAt`. It is
expand-only: `refundReason` and `refundLastRequestedAt` stay nullable on `order_payments` and no
CHECK requires them, because the previous worker still writes ledger rows without them during the
deploy and after a rollback; the CHECK is a later contract migration
([refund cutover](../operations/deployment.md#refund-cutover)).
`packages/db/src/refund-reconciler-migration.test.ts` pins the backfill and the previous worker's
writes on the migrated schema.

Catalog API (`apps/web`): `events.list`, `events.get`, `seats.map`. Inputs and outputs are zod
validated; an unknown event id is `NOT_FOUND`. The tRPC context carries `db`.

### `payment` schema

The mock Payment service ([ADR 0009](../adr/0009-per-service-schemas.md)) owns tables in the
`payment` schema; booking never reads them and they carry no foreign keys to `public`.

| Table                        | Purpose                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payment.outbox_events`      | Payment's own outbox, same shape as `public.outbox_events`; the relay drains both                                                                                                                |
| `payment.processed_messages` | Payment consumer dedupe, same shape as `public.processed_messages`                                                                                                                               |
| `payment.payment_attempts`   | One row per provider attempt (`CAPTURED`, or `FAILED` with its `failureReason`): unique `(orderId, attemptNo)`; CHECKs `CAPTURED ⇔ capturedAt IS NOT NULL`, `FAILED ⇔ failureReason IS NOT NULL` |
| `payment.refunds`            | One executed refund per payment: `paymentId` PK (the once-only guard, AT-23), `orderId`, `amount`, `currency`, `reason` (from the request), `refundedAt`                                         |

### `notification` schema

The mock Notification service owns its tables the same way (ADR 0009); no foreign keys to `public`.

| Table                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification.outbox_events`      | Notification's own outbox, same shape as `public.outbox_events`; the relay drains it                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `notification.processed_messages` | Notification consumer dedupe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `notification.notifications`      | One row per (`sourceEventId` = `order.confirmed`, `order.cancelled`, `order.expired`, `payment.refund_requested` or `payment.refunded` event id, `channel` `EMAIL\|SMS`): `recipient`, `template` (`order-confirmation`, `order-cancellation`, `order-expiry`, `refund-initiated`, `refund-completed`), `status` `PENDING\|SENT`, `dedupeKey` (`refund:<paymentId>:<template>` for a refund step, `event:<id>` otherwise; NULL only on a row a pre-migration worker wrote); unique `(sourceEventId, channel)` and `(dedupeKey, channel)` |

### `outbox_events`

The same shape in each service's schema (`public`, `payment`, `notification`).

| Column                         | Notes                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `id` (uuid)                    | Also the **idempotency key** consumers deduplicate on (`Nats-Msg-Id`); a requeue keeps it                           |
| `aggregateType`, `aggregateId` | Stream identity; relay preserves per-aggregate order among `PENDING` rows                                           |
| `eventType`                    | Broker subject/topic, e.g. `order.confirmed` (published on `ta.<eventType>`)                                        |
| `payload` (jsonb)              | The full event envelope; never changed after insert, `FAILED` rows included                                         |
| `status`                       | `PENDING` → `PUBLISHED`, or `PENDING` → `FAILED` at the permanent-failure cap; a requeue moves `FAILED` → `PENDING` |
| `attempts`, `lastError`        | Every failed publish, transient or permanent, and the latest reason                                                 |
| `permanentFailures`            | Permanent failures since insert or the last requeue; the relay's cap (default 5) applies to it                      |
| `failedAt` (timestamptz)       | When the row became `FAILED`; set exactly while `status = 'FAILED'` (CHECK `outbox_events_failed_at_check`)         |
| `createdAt`, `publishedAt`     | Ordering and lag monitoring; `publishedAt` stays null on a `FAILED` row                                             |

Indexes: `(status, createdAt)` serves the relay's "oldest pending first" poll;
`(aggregateType, aggregateId)` serves per-aggregate lookups.

**`FAILED` rows** ([ADR 0022](../adr/0022-terminal-failed-outbox-events.md)) keep everything they were
inserted with (id, aggregate, event type and payload, byte for byte): they are never deleted, never
`PUBLISHED`, and any retention rule for outbox rows must exclude them (none deletes outbox rows yet).
The relay never claims them, so they no longer hold back later rows of their aggregate. Only an
operator's requeue (`requeueFailedOutboxEvent`, runbook
[failed-outbox-event](../messaging/failed-outbox-event.md)) brings one back to `PENDING`.

### `outbox_event_history`

Append-only audit per outbox row, one table in each service's schema, `outboxId` → `outbox_events.id`
(`ON DELETE CASCADE`, index `(outboxId, id)`). Rows are only inserted, never updated or deleted;
`readOutboxHistory(db, service, outboxId)` returns them in `id` order.

| Column                   | Notes                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `id` (bigserial)         | Append order                                                                                       |
| `kind`                   | `PUBLISH_FAILED` (one permanent publish failure) or `STATUS_CHANGED` (CHECK)                       |
| `fromStatus`, `toStatus` | Only on `STATUS_CHANGED`: `PENDING` → `FAILED` (relay, at the cap), `FAILED` → `PENDING` (requeue) |
| `attempt`                | The row's `attempts` when the entry was written                                                    |
| `error`                  | The failure reason; required on `PUBLISH_FAILED`                                                   |
| `operator`, `reason`     | Who requeued the row and why (requeue entries only)                                                |
| `at` (timestamptz)       | When it happened                                                                                   |

Transient failures (a broker outage, a full stream) are not recorded here; they only count in
`attempts` and `lastError`, so an outage cannot flood the history. Migration
`20261130000000_terminal_failed_outbox_events` added the two columns, the history tables and the CHECKs.

## Rules

- Every state change that other services must hear about writes its outbox row **in the same
  transaction** (see [ADR 0003](../adr/0003-transactional-outbox.md)).
- Schema changes go through `pnpm --filter @ticketarena/db db:migrate`; migrations are committed.
  `schema.prisma` must declare exactly what the migrations build: the drift test
  (`packages/db/src/schema-drift.test.ts`, part of `pnpm run test`) runs `prisma migrate diff`
  from a database built by every committed migration to the schema's datamodel and fails on any
  difference. Its failure message is the SQL Prisma would generate to close the gap, each
  statement naming the table and column that disagree: `ALTER COLUMN ... SET DATA TYPE` means
  a field's `@db` type does not match its migration, `DROP COLUMN` means a migration adds what
  the schema does not declare, and `ADD COLUMN` means the schema declares what no migration adds.
- Concurrency-sensitive writes (seat holds, purchases) must state their isolation strategy in
  the spec (row locks, unique constraints, or optimistic versioning).
