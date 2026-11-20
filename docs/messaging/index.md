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
  never processed. An optional `beforeTransaction(message)` step runs first, outside the transaction, on every
  delivery (duplicates included); it is for slow work that needs no database, must be safe to repeat, and a throw
  `nak`s like a handler failure. A handler may instead resolve to a `HandlerOutcome`
  (`{ outcome: "retry" | "poison", reason }`): the transaction rolls back (no `processed_messages` row, no
  outbox writes) and the message is `nak`ed with the same delay; `poison` is logged as an error. Until the DLQ
  exists, poison is redelivered rather than `term`ed, because ADR 0011 forbids `term` without a DLQ copy.
  The DLQ gate and recovery from ADR 0011 are not built yet.
- **Port:** `MessageBus` hides the broker; `jetstream-message-bus.ts` is the only module importing
  `@nats-io/*` (a test enforces it). `message-bus.contract.ts` is the contract suite run against real NATS.

## Event catalogue

Each slice that emits an event adds a row here. Every event travels in the envelope from
`packages/contracts` (`id`, `type`, `version`, `occurredAt`, `correlationId`, `causationId`,
optional `holdId`/`orderId`, `payload`); the full envelope is stored as the outbox row payload.

| Event type          | Producer                                         | Consumers                | Payload version |
| ------------------- | ------------------------------------------------ | ------------------------ | --------------- |
| `seat.held`         | `BookingService.holdSeats` (same TX)             | none yet                 | 1               |
| `hold.released`     | `BookingService.releaseHold` (same TX)           | none yet                 | 1               |
| `hold.expired`      | `BookingService.sweepExpired` (same TX)          | none yet                 | 1               |
| `order.placed`      | `BookingService.placeOrder` (same TX)            | `payment`                | 1               |
| `payment.succeeded` | mock Payment handler (same TX, `payment` outbox) | `booking-saga`           | 1               |
| `payment.failed`    | mock Payment handler (same TX, `payment` outbox) | `booking-saga-failed`    | 1               |
| `order.confirmed`   | booking saga handler (same TX)                   | `notification`           | 1               |
| `order.cancelled`   | booking saga handler (same TX)                   | `notification-cancelled` | 1               |
| `order.expired`     | `BookingService.sweepExpired` (same TX)          | `notification-expired`   | 1               |

`seat.held` payload: `holdId`, `eventId`, `seatIds`, `holdExpiresAt`. Its `correlationId` is
minted here and reused by every later event of the booking.

`hold.released` payload: `holdId`, `seatIds` (the seats this release freed; may be empty when every
seat was taken over). It carries the hold's `correlationId` and `causationId: null`.

`hold.expired` payload: `holdId`, `seatIds` (the seats this expiry freed; may be empty when every
seat was taken over lazily). It carries the hold's `correlationId` and `causationId: null`.

`order.placed` payload: `orderId`, `holdId`, `amountMinor`, `currency`, `paymentDeadline`, `contact`
(`email`, optional `phone`). It carries the hold's `correlationId`.

`order.expired` payload: `orderId`, `contact` (`email`, optional `phone`). Written when the sweeper
expires an unpaid order at `paymentDeadline + 60 s`; it carries the order's `correlationId`, `holdId`,
`orderId` and `causationId: null`.

`payment.succeeded` payload: `paymentId`, `orderId`, `attemptNo`, `amount` (minor units), `currency`,
`capturedAt` (provider time). `order.confirmed` payload: `orderId`, `seatIds`, `totalMinor`, `currency`,
`contact`.

`payment.failed` payload: `paymentId`, `orderId`, `attemptNo`, `final`, `reason`. `final: false` is
a failed attempt, not a failed checkout. `order.cancelled` payload: `orderId`, `reason`
(`payment_failed`), `contact`; it carries the order's `holdId`, `orderId` and correlation.

## Notification

`notification` (`service: "notification"`, `apps/worker/src/notification/`) consumes `order.confirmed`
(template `order-confirmation`); the durable consumer `notification-expired` runs the same handler on
`order.expired` (template `order-expiry`) and `notification-cancelled` on `order.cancelled` (template
`order-cancellation`), because a durable consumer takes one filter subject. Per
channel (EMAIL; SMS when a phone was given) it first commits a `PENDING` `notification.notifications`
row in its own transaction (via the injected `prisma`), calls the provider with
`idempotencyKey = notification id`, then marks it `SENT` in the handler's transaction. A failed send
leaves the `PENDING` row; redelivery resumes it with the same key. Unique `(sourceEventId, channel)`
plus the consumer's `processed_messages` keep a redelivered or `+dup@` event at one record per
channel. The mock provider records deliveries and dedupes by key.
**External delivery is at-least-once**: a crash between the call and the `SENT` commit repeats it on redelivery, and only
the provider's key dedupe absorbs that.

## Payment saga

`apps/worker/src/consumers.ts` registers the durable consumers `payment`, `booking-saga` and
`booking-saga-failed`. `payment` (`service: "payment"`) handles `order.placed` in
`apps/worker/src/payment/`: one `payment.payment_attempts` row (attempt 1) and one result event, with
latency and outcome drawn from the injected `Random`/`Clock`. Outcome: a `+fail@` email is a final
failure (`FAILED`, `failureReason` `card_declined`, `payment.failed` with `final: true`); otherwise
the attempt captures (`CAPTURED`, `payment.succeeded`) when the draw is below `successRate`
(`paymentSuccessRate` in `createServiceConsumers`, default 1) and else fails non-finally
(`provider_declined`, `final: false`). **Invariant:** `final: true` is never emitted while another
attempt of the order is `ATTEMPTING` or `CAPTURED`. The check reads committed attempts only, which
suffices while the MVP records only attempt 1. It is not safe under concurrent attempts: adding
retries requires serializing attempts per order in every branch first. A `+dup@` email emits the
result twice under distinct event ids.

**Provider latency runs outside the transaction**, in the runner's `beforeTransaction` step, i.e.
before dedupe-and-capture (TD-051). Awaited inside the runner's transaction it would hold a pooled
connection idle for the whole wait, and a wait longer than the interactive-transaction timeout
(Prisma's default 5 s, set per client via `createPrismaClient({ transaction })`) would roll the
capture back and redeliver the message forever. A redelivered `order.placed` waits again and is
then acked as a duplicate by the `processed_messages` insert, so the wait never causes a second
capture or a second `payment.succeeded`. `booking-saga` handles
`payment.succeeded` and `booking-saga-failed` handles `payment.failed`, both with
`createPaymentSagaHandler` (`packages/booking`). In the runner's transaction
(whose `processed_messages` insert is the dedupe check): lock the order `FOR UPDATE`, read its
ledger, lock its seats if it is `PENDING_PAYMENT` (the only state whose seats change), only then
take `T = clock.now()` once (ADR 0005: decision time after all locks), call the pure `decide(orderState, ledger, event, T)`
(`saga-decision.ts`, the spec's matrix), then apply. `decide` returns `transition | noop | refund |
retry | poison`, every non-transition with a reason code (`noop` reasons such as
`duplicate_payment` are logged). Applied so far: `transition` `payment_on_time` (order `CONFIRMED`
by a conditional update, `APPLIED` ledger row, seats `SOLD`, `order.confirmed` stamped with `T`; a
zero-row update throws, never counts as success); `transition` `final_failure` (a final failure on a
`PENDING_PAYMENT` order with no `APPLIED` payment: order `CANCELLED` by a conditional update, its
`IN_CHECKOUT` seats `AVAILABLE` with `holdId`/`claimBuyerKey` cleared, `order.cancelled`, no ledger
row); `noop` (ack; a non-final failure, reason `attempt_failed`, is also counted as
`payment_attempt_failed` in the event's Redis counter hash, best-effort, and leaves the order open
until its deadline); `retry` and `poison` (unknown
`orderId`) are returned to the runner as a `HandlerOutcome`. Decisions whose side effects later
tickets build (late capture → `EXPIRED` + refund, amount mismatch and payments on settled orders →
refund) throw `... is not handled yet` and are retried, so captured money is never dropped
silently. `decide` already covers `payment.refunded`; the saga subscribes to it once its contract
exists.

Relay and runner take a `service` (`booking` default, `payment` or `notification`) that selects the outbox and
`processed_messages` of that schema (ADR 0009); the worker runs one relay per outbox.

## Decided, not yet built

The DLQ gate and consumer recovery script are still to come. Broker: NATS JetStream behind a `MessageBus` port ([ADR 0004](../adr/0004-nats-jetstream-message-bus.md)).
Retries, DLQ and consumer recovery: [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md).
Planned subjects and the envelope: [MVP spec, Messaging](../specs/ticketarena-mvp.md#messaging).
The catalogue above is filled in as slices emit events.
