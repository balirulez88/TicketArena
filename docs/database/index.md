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

| Table           | Purpose                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `outbox_events` | Transactional outbox: integration events written in the business TX                                       |
| `venues`        | Seeded venues                                                                                             |
| `sections`      | Priced area of a venue: `priceMinor` (integer minor units), `currency` `EUR`                              |
| `rows`          | Row label within a section                                                                                |
| `events`        | `onSaleAt`, `queueOpensAt`, `queueClosesAt`, `demo` flag; unique `name`                                   |
| `seats`         | **Per event** seat: `status` `AVAILABLE\|HELD\|IN_CHECKOUT\|SOLD`, `holdId?`, `claimBuyerKey?`            |
| `holds`         | A buyer's hold: `buyerKey`, `status` `HELD\|ORDERED\|RELEASED\|EXPIRED`, `holdExpiresAt`, `correlationId` |

Catalog data is seeded, never edited through the API. `seedCatalog(prisma, now)`
(`packages/db/src/seed.ts`, run with `pnpm --filter @ticketarena/db db:seed`) only inserts
missing rows, so re-running it keeps seat state. Seats are unique on `(eventId, rowId, number)`
and indexed on `(eventId, status)`.

Booking: `booking.holdSeats` (one seat for now) and `booking.getHold` (owner only, else
`NOT_FOUND`) delegate to `BookingService` (`packages/booking`). `holdSeats` runs one transaction:
`SELECT … FOR UPDATE` on the seat, then `T = clock.now()` read **after** the lock, then the `holds`
row (`holdExpiresAt = T + 10 min`, fresh `correlationId`), the seat set `HELD`, and a `seat.held`
row in `outbox_events` whose `payload` is the full event envelope and whose `id` is the envelope
`id`. A seat that is not `AVAILABLE` fails with `SEAT_UNAVAILABLE` (tRPC `CONFLICT`) naming its id.
No SQL `now()`; the `Clock` is injected.

Catalog API (`apps/web`): `events.list`, `events.get`, `seats.map`. Inputs and outputs are zod
validated; an unknown event id is `NOT_FOUND`. The tRPC context carries `db`.

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
