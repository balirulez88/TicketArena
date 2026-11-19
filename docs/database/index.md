# Database

[← System map](../index.md)

## Stack

- **Neon** serverless PostgreSQL. Use the **pooled** connection string at runtime because
  serverless functions open many short-lived connections.
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

| Table                | Purpose                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `outbox_events`      | Transactional outbox: integration events written in the business TX                                               |
| `processed_messages` | Consumer dedupe checkpoint: `(consumer, messageId)` primary key, written in the handler's TX (ADR 0007)           |
| `venues`             | Seeded venues                                                                                                     |
| `sections`           | Priced area of a venue: `priceMinor` (integer minor units), `currency` `EUR`                                      |
| `rows`               | Row label within a section                                                                                        |
| `events`             | `onSaleAt`, `queueOpensAt`, `queueClosesAt`, `demo` flag; unique `name`                                           |
| `seats`              | **Per event** seat: `status` `AVAILABLE\|HELD\|IN_CHECKOUT\|SOLD`, `holdId?`, `claimBuyerKey?`                    |
| `holds`              | A buyer's hold: `buyerKey`, `status` `HELD\|ORDERED\|RELEASED\|EXPIRED`, `holdExpiresAt`, `correlationId`         |
| `orders`             | One per hold: contact, `totalMinor`, `status`, fixed `paymentDeadline`, unique `(sessionId, idempotencyKey)`      |
| `order_lines`        | Seat prices copied at placement                                                                                   |
| `order_payments`     | Ledger of captured money: `paymentId` PK, `amount`, `capturedAt`, `disposition` (`APPLIED` for a confirmed order) |

Catalog data is seeded, never edited through the API. `seedCatalog(prisma, now)`
(`packages/db/src/seed.ts`, run with `pnpm --filter @ticketarena/db db:seed`) only inserts
missing rows, so re-running it keeps seat state. Seats are unique on `(eventId, rowId, number)`
and indexed on `(eventId, status)` and on `holdId`. `venues.name` is unique, so `seedCatalog` upserts venues
and concurrent seed runs leave one row per venue. The demo event goes on sale one day before the
seeding instant (its queue window has closed), so holds and `admin.runRace` work at once; the
other events go on sale 14 and 30 days after it. A database seeded before this rule keeps its
demo event's later `onSaleAt` (re-running the seed never updates a row); reset the database to
pick it up.

### Indexes and unique constraints

`packages/db/src/docs.test.ts` fails when a migration creates one that is not named here.

| Name                                          | On                                          | Why                                              |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------ |
| `venues_name_key`                             | `venues(name)` unique                       | Seed upserts; one row per venue                  |
| `sections_venueId_name_key`                   | `sections(venueId, name)` unique            | Seed upserts                                     |
| `rows_sectionId_label_key`                    | `rows(sectionId, label)` unique             | Seed upserts                                     |
| `events_name_key`                             | `events(name)` unique                       | Seed upserts                                     |
| `seats_eventId_rowId_number_key`              | `seats(eventId, rowId, number)` unique      | One seat per event position                      |
| `seats_eventId_status_idx`                    | `seats(eventId, status)`                    | Seat map and availability                        |
| `seats_holdId_idx`                            | `seats(holdId)`                             | `getHold` and hold lifecycle updates (FK lookup) |
| `holds_eventId_buyerKey_idx`                  | `holds(eventId, buyerKey)`                  | Per-buyer lookups                                |
| `orders_holdId_key`                           | `orders(holdId)` unique                     | A hold yields at most one order                  |
| `orders_sessionId_idempotencyKey_key`         | `orders(sessionId, idempotencyKey)` unique  | Idempotent `placeOrder`                          |
| `order_lines_orderId_seatId_key`              | `order_lines(orderId, seatId)` unique       | One line per seat                                |
| `order_payments_orderId_idx`                  | `order_payments(orderId)`                   | Ledger lookup per order (FK)                     |
| `order_payments_orderId_applied_key`          | `order_payments(orderId)` unique, partial   | At most one `APPLIED` payment per order          |
| `outbox_events_status_createdAt_idx`          | `outbox_events(status, createdAt)`          | Relay polling                                    |
| `outbox_events_aggregateType_aggregateId_idx` | `outbox_events(aggregateType, aggregateId)` | Aggregate lookup                                 |

Booking: `booking.holdSeats` (1–6 seats of one event, all or nothing) and `booking.getHold` (owner only, else
`NOT_FOUND`) delegate to `BookingService` (`packages/booking`). `holdSeats` first requires a valid
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

Metrics: an optional `BookingMetrics` port counts `hold_ok`, `limit_exceeded`, `seat_unavailable` (snapshot refusals,
and refusals under the lock of seats nobody changed since the snapshot, such as a seat outside
the event) and `race_lost` (refused under the lock because a refused
seat's status or hold changed after the snapshot read it) per event. Counters are bumped
after the outcome is decided, fire-and-forget; a failure is logged and never fails a booking. The
Redis adapter (`createRedisBookingMetrics`) keeps one hash per event,
`booking:metrics:<eventId>`, with the metric as field. Seat state is never decided by Redis.

Saturation: a `holdSeats` whose pool acquire (`pg` `connectionTimeoutMillis`) or transaction start
(Prisma `maxWait`, `P2028`) times out fails with `BookingBusyError` (`BOOKING_BUSY`, tRPC
`TOO_MANY_REQUESTS`) and counts `booking_busy`. `createPrismaClient` takes `poolMax`,
`acquireTimeoutMs` and `transaction` so callers size pool and timeouts. Lock-timeout and deadlock
retry, and the same mapping for `placeOrder`, are ticket 54 (TD-020).
Tests fill a one-connection pool with `occupy` (`@ticketarena/booking/testing`, never the package's
main entry): it resolves after a query has run inside the occupying transaction, and retries any
failure before that point, up to a deadline, because a short acquire timeout also bounds opening
the pool's first connection.

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

Releasing: `booking.releaseHold` (owner only, else `NOT_FOUND`) gives back a `HELD` hold; any
other status is `HOLD_NOT_ACTIVE` (tRPC `CONFLICT`). An expired but unswept hold is still `HELD`
and can be released. One transaction with the same lock order as `placeOrder` (buyer lock, hold
`FOR UPDATE`, then the seats still `HELD` with this `holdId` `ORDER BY id FOR UPDATE`) sets the
hold `RELEASED`, sets exactly those seats `AVAILABLE` with `holdId` and `claimBuyerKey` cleared (a
seat taken over by another hold is left alone), and writes a `hold.released` outbox row. The
returned hold view lists the freed seats; the seats are holdable by anyone as soon as it commits.
Releasing a hold does not end shopping: the buyer's waiting-room slot is untouched (slot logic
arrives in ticket 30; only `placeOrder`, leaving or reaping end it).

Expiry: one `T` per transaction and one rule everywhere, a hold is valid iff `T < holdExpiresAt`
(snapshot, lazy takeover, buyer limit, `placeOrder`, sweeper). `BookingService.sweepExpired()` is
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
expiry (AT-10). An order the payment saga has locked is skipped and re-checked next sweep. The hold
stays `ORDERED`. `apps/worker` runs it every 15 s.

### Demo reset

`BookingService.resetEvent(eventId)` returns the demo event to its seeded state so the race can run
again. One transaction: it refuses any event whose `demo` flag is not set (`NOT_DEMO_EVENT`), then
locks the event's `holds`, their `orders` and its `seats` (each `ORDER BY id FOR UPDATE`, in that
order, which no booking path inverts: `placeOrder` locks a hold before seats, the saga and sweeper
an order before seats). It is `RESET_BLOCKED` while an order is `PENDING_PAYMENT` or a refund
obligation is open (an `order_payments` row `REFUND_REQUESTED` or `MANUAL_REVIEW`), and also when a
seat carries a hold it did not lock (a booking committed mid-reset); blocked means nothing
changed. Otherwise it sets every seat not plain `AVAILABLE` back to `AVAILABLE` (`holdId`,
`claimBuyerKey` cleared) and deletes the event's `order_payments`, `order_lines`, `orders` and
`holds`; it returns the counts. Kept on purpose: `public.outbox_events` (history the relay may
still be publishing; a new hold has a new id, so `placeOrder`'s `seat.held` lookup is unaffected),
`processed_messages`, and everything in the `payment` and `notification` schemas (ADR 0009: no
cross-schema deletes). Only `admin.resetDemo` calls it. `reset-event.test.ts` races the reset
against `holdSeats`, `placeOrder`, the payment saga and both sweepers on real Postgres to pin these
guarantees.

Known limitation: the reset deletes `EXPIRED` and `CANCELLED` demo orders even while a late
capture for one may still be in flight, so the later `payment.succeeded` meets an unknown order
(`decide` returns `poison` for an unknown `orderId`, as the spec requires; until the DLQ exists the
message is redelivered on the retry schedule). Whether such a capture should be refunded instead is
an open question for the late-payment ticket.

Catalog API (`apps/web`): `events.list`, `events.get`, `seats.map`. Inputs and outputs are zod
validated; an unknown event id is `NOT_FOUND`. The tRPC context carries `db`.

### `payment` schema

The mock Payment service ([ADR 0009](../adr/0009-per-service-schemas.md)) owns tables in the
`payment` schema; booking never reads them and they carry no foreign keys to `public`.

| Table                        | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `payment.outbox_events`      | Payment's own outbox, same shape as `public.outbox_events`; the relay drains both                                                             |
| `payment.processed_messages` | Payment consumer dedupe, same shape as `public.processed_messages`                                                                            |
| `payment.payment_attempts`   | One row per provider attempt: unique `(orderId, attemptNo)`; CHECKs `CAPTURED ⇔ capturedAt IS NOT NULL`, `FAILED ⇔ failureReason IS NOT NULL` |

### `notification` schema

The mock Notification service owns its tables the same way (ADR 0009); no foreign keys to `public`.

| Table                             | Purpose                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification.outbox_events`      | Notification's own outbox, same shape as `public.outbox_events`; the relay drains it                                                                                                                                               |
| `notification.processed_messages` | Notification consumer dedupe                                                                                                                                                                                                       |
| `notification.notifications`      | One row per (`sourceEventId` = `order.confirmed` or `order.expired` event id, `channel` `EMAIL\|SMS`): `recipient`, `template` (`order-confirmation`, `order-expiry`), `status` `PENDING\|SENT`; unique `(sourceEventId, channel)` |

### `outbox_events`

| Column                         | Notes                                                   |
| ------------------------------ | ------------------------------------------------------- |
| `id` (uuid)                    | Also the **idempotency key** consumers deduplicate on   |
| `aggregateType`, `aggregateId` | Stream identity; relay preserves per-aggregate order    |
| `eventType`                    | Broker subject/topic, e.g. `booking.confirmed`          |
| `payload` (jsonb)              | Versioned event body                                    |
| `status`                       | `PENDING` → `PUBLISHED`, or `FAILED` after max attempts |
| `attempts`, `lastError`        | Retry bookkeeping for the relay                         |
| `createdAt`, `publishedAt`     | Ordering and lag monitoring                             |

Indexes: `(status, createdAt)` serves the relay's "oldest pending first" poll;
`(aggregateType, aggregateId)` serves per-aggregate lookups.

## Rules

- Every state change that other services must hear about writes its outbox row **in the same
  transaction** (see [ADR 0003](../adr/0003-transactional-outbox.md)).
- Schema changes go through `pnpm --filter @ticketarena/db db:migrate`; migrations are committed.
- Concurrency-sensitive writes (seat holds, purchases) must state their isolation strategy in
  the spec (row locks, unique constraints, or optimistic versioning).
