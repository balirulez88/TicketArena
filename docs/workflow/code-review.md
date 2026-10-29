# Code Review Focus

[← Workflow](index.md)

Project-specific guidance for the generic [`code-review`](../../skills/code-review/SKILL.md)
skill. The skill finds this file through `CLAUDE.md`; it adds TicketArena's rules to the skill's
generic smell and risk baselines. Severities follow the skill. Whether a finding blocks a merge is
the [Ralph merge policy](index.md#independent-review), not this file.

Authoritative context, in order: accepted [ADRs](../adr/index.md), the
[MVP spec](../specs/ticketarena-mvp.md), [`CLAUDE.md`](../../CLAUDE.md) conventions, the
[glossary](../glossary.md). A review never suggests contradicting an ADR; that needs a new ADR.

## Stack (review at these versions)

Node 24, TypeScript 6 strict, Next.js 16 App Router (`proxy.ts`, not `middleware.ts`), React 19,
tRPC v11, Prisma 7 with injected driver adapters, PostgreSQL 17, Redis 7, NATS JetStream, zod 4,
Vitest. Biome and `tsc` already enforce formatting, lint rules and types: do not re-report them.

## Hard rules (a breach is at least `HIGH`)

- **Lock order** ([ADR 0005](../adr/0005-postgres-seat-state-row-locks.md)): buyer advisory lock →
  hold → order → seats `ORDER BY id`. The clock is read **after** the locks are held. Seat state is
  decided in Postgres, never by Redis alone.
- **Outbox** ([ADR 0003](../adr/0003-transactional-outbox.md)): anything another service must
  learn about is written to that service schema's outbox in the **same transaction** as the state
  change. No direct publish from a business transaction.
- **Idempotency** ([ADR 0007](../adr/0007-three-layer-idempotency.md)): every consumer is idempotent
  via `processed_messages`; request idempotency keys are honoured; retries cannot double-book,
  double-charge or double-refund.
- **Payments** ([ADR 0006](../adr/0006-booking-saga-payment-ledger.md)): the `order_payments`
  ledger records captured payments only; confirming an order and inserting its `APPLIED` ledger
  row are one transaction; a late or duplicate payment is always refunded, never dropped.
- **Delivery** ([ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md)): ack only after the
  handler's transaction commits; the DLQ gate runs before the handler; recovery may replay but
  never skip an unprocessed message.
- **Schemas** ([ADR 0009](../adr/0009-per-service-schemas.md)): a service touches only its own
  schema.
- **Admission** ([ADR 0008](../adr/0008-waiting-room-admission.md)): the admission token gates
  `holdSeats` only.
- **Boundaries** (`CLAUDE.md`): packages never read `process.env`; apps validate config and all
  external input with zod at the boundary and inject dependencies.
- **Tests** ([ADR 0010](../adr/0010-real-infrastructure-tests.md)): integration tests run on real
  Postgres, Redis and NATS; mocks only at system boundaries (network, time, randomness), never our
  own modules; concurrency claims need a test that actually races.

## Scope

The MVP spec is deliberately small. Extra architecture, features or configurability beyond the
ticket is scope creep (Spec axis). Known limitations belong in docs, not in speculative code.
