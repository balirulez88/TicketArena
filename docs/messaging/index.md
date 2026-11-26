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
[ADR 0004](../adr/0004-nats-jetstream-message-bus.md)) and only then starts the relay. It never waits for Redis: the relay, the consumers and the sweeper
run during a Redis outage (see [waiting room](../architecture/waiting-room.md#redis-outage)). It serves
`GET /health`, which reports Redis separately (`"redis": "ok" | "unavailable"`).

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
  delivery (duplicates included); it is for slow work that must not hold the transaction (a provider's latency or
  call; it may commit its own short writes, never the dedupe row), must be safe to repeat, and a throw `nak`s like a
  handler failure. A handler may instead resolve to a `HandlerOutcome`
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

| Event type                 | Producer                                                                | Consumers                                         | Payload version |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| `seat.held`                | `BookingService.holdSeats` (same TX)                                    | none yet                                          | 1               |
| `hold.released`            | `BookingService.releaseHold` (same TX)                                  | none yet                                          | 1               |
| `hold.expired`             | `BookingService.sweepExpired` (same TX)                                 | none yet                                          | 1               |
| `order.placed`             | `BookingService.placeOrder` (same TX)                                   | `payment`                                         | 1               |
| `payment.succeeded`        | mock Payment handler (same TX, `payment` outbox)                        | `booking-saga`                                    | 1               |
| `payment.failed`           | mock Payment handler (same TX, `payment` outbox)                        | `booking-saga-failed`                             | 1               |
| `order.confirmed`          | booking saga handler (same TX)                                          | `notification`                                    | 1               |
| `order.cancelled`          | booking saga handler (same TX)                                          | `notification-cancelled`                          | 1               |
| `order.expired`            | `BookingService.sweepExpired`; booking saga on a late capture (same TX) | `notification-expired`                            | 1               |
| `payment.refund_requested` | booking saga handler (same TX)                                          | `payment-refund`, `notification-refund-requested` | 1               |
| `payment.refunded`         | mock Payment refund handler (same TX, `payment` outbox)                 | `booking-saga-refunded`, `notification-refunded`  | 1               |

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
`orderId` and `causationId: null`. The booking saga writes the same event when a late capture
expires the order (caused by the `payment.succeeded`).

`payment.refund_requested` payload: `paymentId`, `orderId`, `amount`, `currency` (as captured),
`reason` (`late_capture`, `late_delivery`, `order_expired`, `order_cancelled`, `order_confirmed`,
`amount_mismatch`, `unknown_order`) and `contact`, which is absent only for `unknown_order`. Its
aggregate is `order_payment` / `paymentId`; it carries the order's `holdId` when the order exists.
The mock Payment service executes it (`payment-refund`, see Payment saga) and Notification tells the
buyer the refund was initiated (`notification-refund-requested`). The reconciler is a later ticket.

`payment.refunded` payload: `paymentId`, `orderId`, `amount`, `currency`, `refundedAt` (provider
time) and the request's `contact`, absent only when the request had none (`unknown_order`). Its
aggregate is `payment` / `paymentId`; it carries the request's `orderId`, `holdId` and correlation.
Notification tells the buyer the refund completed (`notification-refunded`).

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
`order-cancellation`), `notification-refund-requested` on `payment.refund_requested` (template
`refund-initiated`) and `notification-refunded` on `payment.refunded` (template `refund-completed`),
because a durable consumer takes one filter subject. A refund event without a contact (only an
`unknown_order` refund: the order and its buyer are gone) is logged and acked with no record. It
runs in three steps, spread into the runner as `beforeTransaction` + `handler`:

1. **Pending** (`beforeTransaction`): per channel (EMAIL; SMS when a phone was given) it commits a
   `PENDING` `notification.notifications` row in its own short write (via the injected `prisma`), or
   resumes the one a previous delivery left; a channel already `SENT` is skipped.
2. **Send** (`beforeTransaction`, no transaction open): it calls the provider with
   `idempotencyKey = notification id`.
3. **Record** (`handler`, the runner's transaction with the `processed_messages` row): every
   `PENDING` row of the event becomes `SENT`. It is reached only when step 2 sent every channel.

**The send runs outside the transaction** (TD-051): awaited inside the runner's transaction, a slow
provider would hold a pooled connection idle for the whole call, and a call longer than the
interactive-transaction timeout would roll the record back and redeliver the message forever. A
failed send, or a crash after the send and before step 3 commits, leaves the `PENDING` rows and
redelivers the message; the redelivery resends every `PENDING` channel under the same key (the
provider's dedupe keeps it to one delivery each) and then records them `SENT`. So when the SMS send
fails after the EMAIL was sent, both stay `PENDING` and the redelivery offers the EMAIL again.
Unique `(sourceEventId, channel)` plus the consumer's `processed_messages` keep a redelivered or `+dup@` event at one record per
channel (AT-43, for all five kinds). Dedupe is by event id: a refund request re-emitted under a new
event id (the planned reconciler) would be a new source event and send a second `refund-initiated`.
The mock provider records deliveries and dedupes by key.
**External delivery is at-least-once**: a crash between the call and the `SENT` commit repeats it on redelivery, and only
the provider's key dedupe absorbs that.

## Payment saga

`apps/worker/src/consumers.ts` registers the durable consumers `payment`, `payment-refund`,
`booking-saga`, `booking-saga-failed` and `booking-saga-refunded`. `payment` (`service: "payment"`) handles `order.placed` in
`apps/worker/src/payment/`: one `payment.payment_attempts` row (attempt 1) and one result event, with
latency and outcome drawn from the injected `Random`/`Clock`. Outcome: a `+fail@` email is a final
failure (`FAILED`, `failureReason` `card_declined`, `payment.failed` with `final: true`); a `+late@`
email always captures, stamped `capturedAt = paymentDeadline + 1 s` (provider time, delivered at
once, so booking sees a late capture on a still-open order); otherwise
the attempt captures (`CAPTURED`, `payment.succeeded`) when the draw is below `successRate`
(`paymentSuccessRate` in `createServiceConsumers`, default 1) and else fails non-finally
(`provider_declined`, `final: false`). **Invariant:** `final: true` is never emitted while another
attempt of the order is `ATTEMPTING` or `CAPTURED`. The check reads committed attempts only, which
suffices while the MVP records only attempt 1. It is not safe under concurrent attempts: adding
retries requires serializing attempts per order in every branch first. A `+dup@` email emits the
result twice under distinct event ids. An `order.placed` repeated under a new event id gets past
`processed_messages`; the attempt insert skips the existing `(orderId, attemptNo)` row instead, so the
repeat is acked as handled with no second attempt and no second result (the first attempt's result
already went out with it). A concurrent repeat waits on the uncommitted row, then skips it. An
`order.placed` whose payload fails its schema writes nothing and is `nak`ed on the ADR 0011 delay
schedule, redelivered without end until the DLQ gate exists.

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
row); `transition` `late_capture` (a capture after `paymentDeadline` on a `PENDING_PAYMENT` order: order
`EXPIRED` by a conditional update, its `IN_CHECKOUT` seats `AVAILABLE`, a `REFUND_REQUESTED` ledger
row with `refundRequestedAt = T`, `order.expired` and `payment.refund_requested` with reason
`late_capture`; the seats are never reclaimed for that payment, even while still free, AT-20);
`refund` (a capture the order cannot keep: on an `EXPIRED`, `CANCELLED` or `CONFIRMED` order, or
with a mismatched amount: order unchanged, `REFUND_REQUESTED` ledger row, `payment.refund_requested`
with the contact; an on-time capture on an `EXPIRED` order, reason `late_delivery`, is also counted
as `late_delivery_refund`, best-effort); `refund` `unknown_order` (a capture whose order no longer
exists; a demo reset keeps orders, so it is not a cause: no ledger row is possible, so the `payment.refund_requested`
outbox row, without contact, is the obligation; without an order row to lock, the handler takes an
advisory lock on `refund:<paymentId>` and writes the request only if none exists for that payment,
so a redelivery or a duplicate under a new event id refunds it once); `noop` (ack; a non-final
failure, reason `attempt_failed`, is also counted as `payment_attempt_failed` in the event's Redis
counter hash, best-effort, and leaves the order open until its deadline); `retry` and `poison`
(unknown `orderId` on a failure) are returned to the runner as a `HandlerOutcome`. Any decision
the handler does not apply yet throws `... is not handled yet` and is retried, so captured money
is never dropped silently.

**Refund execution.** `payment-refund` (`service: "payment"`, `apps/worker/src/payment/refund-handler.ts`)
consumes `payment.refund_requested`: in the runner's transaction it inserts one `payment.refunds`
row (primary key `paymentId`, `INSERT … ON CONFLICT DO NOTHING`) and, only if that insert wrote the
row, emits `payment.refunded` through the payment outbox. `processed_messages` absorbs a
redelivery; the primary key absorbs a duplicate request under a new event id, including a
concurrent one, whose insert waits on the uncommitted row and then skips it. So a payment is
refunded once and `payment.refunded` is emitted once (AT-23); a skipped duplicate is logged and
acked. Every request is executed, with or without a contact. `booking-saga-refunded` runs
`createPaymentSagaHandler` on `payment.refunded`: `transition` `refund_completed` moves the
payment's ledger row from `REFUND_REQUESTED` or `MANUAL_REVIEW` to `REFUNDED` by a conditional
update (zero rows throws), whatever the order's status (an `amount_mismatch` refund leaves the
order `PENDING_PAYMENT`); the order is unchanged and nothing is emitted. A repeat is `noop`
`already_refunded`. A `paymentId` missing from a known order's ledger is `poison`
(`unknown_payment`, or `refund_for_pending_order` on a `PENDING_PAYMENT` order). For an unknown
`orderId` the handler asks booking's outbox whether it requested a refund of that payment (an
`unknown_order` refund has no ledger row): if so the event is `noop` `unknown_order_refunded`,
else `poison` (`unknown_order`).

Relay and runner take a `service` (`booking` default, `payment` or `notification`) that selects the outbox and
`processed_messages` of that schema (ADR 0009); the worker runs one relay per outbox.

## Decided, not yet built

The DLQ gate and consumer recovery script are still to come. Broker: NATS JetStream behind a `MessageBus` port ([ADR 0004](../adr/0004-nats-jetstream-message-bus.md)).
Retries, DLQ and consumer recovery: [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md).
Planned subjects and the envelope: [MVP spec, Messaging](../specs/ticketarena-mvp.md#messaging).
The catalogue above is filled in as slices emit events.
