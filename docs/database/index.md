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
and concurrent seed runs leave one row per venue.

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
`NOT_FOUND`) delegate to `BookingService` (`packages/booking`). `holdSeats` rejects an empty, duplicated or longer-than-6 `seatIds` list with `INVALID_SEAT_SELECTION` (tRPC
`BAD_REQUEST`) before writing. It then takes a lock-free snapshot read (`seats` joined to `holds`) and
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
a partial hold. A seat that is not `AVAILABLE` fails with `SEAT_UNAVAILABLE` (tRPC `CONFLICT`) naming its id.
No SQL `now()`; the `Clock` is injected.

Metrics: an optional `BookingMetrics` port counts `hold_ok`, `limit_exceeded`, `seat_unavailable` (snapshot refusals,
and refusals under the lock of seats nobody changed since the snapshot, such as an expired but
unswept hold or a seat outside the event) and `race_lost` (refused under the lock because a refused
seat's status or hold changed after the snapshot read it) per event. Counters are bumped
after the outcome is decided, fire-and-forget; a failure is logged and never fails a booking. The
Redis adapter (`createRedisBookingMetrics`) keeps one hash per event,
`booking:metrics:<eventId>`, with the metric as field. Seat state is never decided by Redis.

Timeouts and retry (ADR 0005): `holdSeats` and `placeOrder` run every transaction through one
helper that sets `lock_timeout` 3s and `statement_timeout` 5s (`set_config(..., true)`, local to the
transaction). A transaction Postgres aborts with `40P01`, `55P03` or `40001` is retried whole, up to 3 times,
with jitter, each retry counting `deadlock_retry`; a failed attempt has rolled back completely, so
a retry never sees partial state. Exhausted retries fail with `BookingBusyError` (`BOOKING_BUSY`,
tRPC `TOO_MANY_REQUESTS`, router-mapped for both procedures) and count `booking_busy`.

Saturation: a pool acquire timeout (the `pg-pool` message, pinned against the real driver) or a
Prisma `P2028` saying the transaction could not start in time is also `BOOKING_BUSY`. A `P2028`
for a transaction that outlived its own runtime timeout, or was already closed, is not: the work
may have committed, so it is not reported as retryable. `createPrismaClient` takes `poolMax`,
`acquireTimeoutMs` and `transaction` so callers size pool and timeouts.

Orders: `booking.placeOrder` (no admission required) and `booking.getOrder` (owner only, else
`NOT_FOUND`). `placeOrder` runs one transaction with the lock order buyer lock (same key as `holdSeats`, taken after an unlocked read of the hold's event), hold `FOR UPDATE`, seats
`ORDER BY id FOR UPDATE`, then `T = clock.now()`. It requires a `HELD` hold owned by the caller's
`BuyerKey` (else `NOT_FOUND`), `T < holdExpiresAt` (else `HOLD_EXPIRED`, tRPC
`PRECONDITION_FAILED`) and every seat still `HELD` with this `holdId`; the expected seat set is
read from the hold's `seat.held` outbox event, so a seat that lost its `holdId` fails with
`SEAT_UNAVAILABLE`. A non-`HELD` hold is refused (`HOLD_NOT_ACTIVE`) before the event is read, and a
missing `seat.held` event is `HOLD_SEAT_SET_MISSING` (`CONFLICT`). Lines, total and the `IN_CHECKOUT`
update use exactly that seat set; seats of mixed currencies fail with `MIXED_CURRENCY`. It then writes the `orders`
row (`PENDING_PAYMENT`, `paymentDeadline = T + 5 min`, the hold's `correlationId`) with
`order_lines` copying seat prices, sets the hold `ORDERED` and seats `IN_CHECKOUT`, and writes an
`order.placed` outbox row. Idempotency: a repeated `(sessionId, idempotencyKey)` returns the
stored order; the same key with a different `requestHash` (hold + contact) fails with a
`CONFLICT`. `holdId` is unique on `orders`, so a hold yields at most one order.

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

| Table                             | Purpose                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `notification.outbox_events`      | Notification's own outbox, same shape as `public.outbox_events`; the relay drains it                                                                                     |
| `notification.processed_messages` | Notification consumer dedupe                                                                                                                                             |
| `notification.notifications`      | One row per (`sourceEventId` = `order.confirmed` event id, `channel` `EMAIL\|SMS`): `recipient`, `template`, `status` `PENDING\|SENT`; unique `(sourceEventId, channel)` |

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
