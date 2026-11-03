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

## Worker, relay and consumer runner

`apps/worker` is the long-running process ([ADR 0013](../adr/0013-deployment-topology.md)). On boot it calls
`ensureTopology()` (idempotent; creates `TICKETARENA` and `TICKETARENA_DLQ` as in
[ADR 0004](../adr/0004-nats-jetstream-message-bus.md)) and only then starts the relay. It serves `GET /health`.

- **Relay** (`packages/messaging/src/outbox-relay.ts`): every 250 ms interval it claims a batch of 100 `PENDING`
  rows with `FOR UPDATE SKIP LOCKED` in one transaction, publishes each to `ta.<eventType>` with
  `Nats-Msg-Id = outbox id`, awaits the PubAck and marks the row `PUBLISHED`. A failed publish increments
  `attempts`, stores `lastError` and leaves the row `PENDING`. Only the oldest `PENDING` row of an aggregate is
  claimable (`NOT EXISTS` an older `PENDING` row), so order per aggregate holds across concurrent relays: later
  rows wait for a failed or in-flight earlier one, at one row per aggregate per tick. Rows of a rolled-back transaction never exist for the relay.
- **Consumer runner** (`consumer-runner.ts`): durable pull consumer per consumer name (`AckWait` 30 s,
  no `BackOff`, `MaxDeliver` -1). Each message runs in one transaction that first inserts
  `processed_messages(consumer, messageId, streamSeq)` and then calls the handler. A unique violation of
  that insert is a duplicate and is acked; any handler error, including its own unique violation, rolls back
  and `nak`s with the ADR 0011 delay (1 s, 5 s, 30 s, 2 min). A message without `Nats-Msg-Id` is `term`ed and
  never processed. The DLQ gate and recovery from ADR 0011 are not built yet.
- **Port:** `MessageBus` hides the broker; `jetstream-message-bus.ts` is the only module importing
  `@nats-io/*` (a test enforces it). `message-bus.contract.ts` is the contract suite run against real NATS.

## Event catalogue

Each slice that emits an event adds a row here. Every event travels in the envelope from
`packages/contracts` (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`,
optional `holdId`/`orderId`, `payload`); the full envelope is stored as the outbox row payload.

| Event type          | Producer                                         | Consumers      | Payload version |
| ------------------- | ------------------------------------------------ | -------------- | --------------- |
| `seat.held`         | `BookingService.holdSeats` (same TX)             | none yet       | 1               |
| `order.placed`      | `BookingService.placeOrder` (same TX)            | `payment`      | 1               |
| `payment.succeeded` | mock Payment handler (same TX, `payment` outbox) | `booking-saga` | 1               |
| `order.confirmed`   | booking saga handler (same TX)                   | none yet       | 1               |

`seat.held` payload: `holdId`, `eventId`, `seatIds`, `holdExpiresAt`. Its `correlationId` is
minted here and reused by every later event of the booking.

`order.placed` payload: `orderId`, `holdId`, `amountMinor`, `currency`, `paymentDeadline`, `contact`
(`email`, optional `phone`). It carries the hold's `correlationId`.

`payment.succeeded` payload: `paymentId`, `orderId`, `attemptNo`, `amount` (minor units), `currency`,
`capturedAt` (provider time). `order.confirmed` payload: `orderId`, `seatIds`, `totalMinor`, `currency`,
`contact`.

## Payment saga (happy path)

`apps/worker/src/consumers.ts` registers two durable consumers. `payment` (`service: "payment"`)
handles `order.placed` in `apps/worker/src/payment/`: one CAPTURED `payment.payment_attempts` row and a
`payment.succeeded` event, with latency and outcome drawn from the injected `Random`/`Clock`. A
`+dup@` email emits the result twice under distinct event ids. `booking-saga` handles
`payment.succeeded` (`createPaymentSagaHandler`, `packages/booking`): lock the order, ignore a known
`paymentId`, else in one transaction set the order `CONFIRMED`, insert the `APPLIED` ledger row, set
the seats `SOLD` and write `order.confirmed`. Late, mismatched or non-pending cases throw (retried)
until the later tickets build the rest of the decision matrix.

Relay and runner take a `service` (`booking` default, or `payment`) that selects the outbox and
`processed_messages` of that schema (ADR 0009); the worker runs one relay per outbox.

## Decided, not yet built

The DLQ gate and consumer recovery script are still to come. Broker: NATS JetStream behind a `MessageBus` port ([ADR 0004](../adr/0004-nats-jetstream-message-bus.md)).
Retries, DLQ and consumer recovery: [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md).
Planned subjects and the envelope: [MVP spec, Messaging](../specs/ticketarena-mvp.md#messaging).
The catalogue above is filled in as slices emit events.
