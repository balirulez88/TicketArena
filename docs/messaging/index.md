# Async Messaging

[← System map](../index.md)

## Why asynchronous

Payment capture and notifications are slow, failure-prone, third-party-dependent work. Keeping
them off the booking request path protects checkout latency during an on-sale spike and lets
each service retry independently.

## Outbox pattern

```text
 booking TX ──► INSERT seat/order rows ─┐
                INSERT outbox_events  ──┴─ COMMIT (atomic)
                                          │
 relay ──► SELECT … WHERE status=PENDING ORDER BY createdAt FOR UPDATE SKIP LOCKED
       ──► publish to broker ──► UPDATE status=PUBLISHED
                                          │
 consumers (payment, notification) ◄──────┘  dedupe on event id
```

**Guarantee:** at-least-once delivery. A relay crash after publishing but before marking the row
`PUBLISHED` re-sends the event, so every consumer must be **idempotent** (track processed event
ids or make the side effect naturally idempotent).

`FOR UPDATE SKIP LOCKED` lets several relay instances drain the outbox concurrently without
publishing the same row twice in one pass.

## Event catalogue

Each slice that emits an event adds a row here. Every event travels in the envelope from
`packages/contracts` (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`,
optional `holdId`/`orderId`, `payload`); the full envelope is stored as the outbox row payload.

| Event type  | Producer                             | Consumers | Payload version |
| ----------- | ------------------------------------ | --------- | --------------- |
| `seat.held` | `BookingService.holdSeats` (same TX) | none yet  | 1               |

`seat.held` payload: `holdId`, `eventId`, `seatIds`, `holdExpiresAt`. Its `correlationId` is
minted here and reused by every later event of the booking.

## Decided, not yet built

Broker: NATS JetStream behind a `MessageBus` port ([ADR 0004](../adr/0004-nats-jetstream-message-bus.md)).
Retries, DLQ and consumer recovery: [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md).
Planned subjects and the envelope: [MVP spec, Messaging](../specs/ticketarena-mvp.md#messaging).
The catalogue above is filled in as slices emit events.
