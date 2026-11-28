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
`ensureTopology()` (creates `TICKETARENA` and `TICKETARENA_DLQ` as in
[ADR 0004](../adr/0004-nats-jetstream-message-bus.md)), binds its health port, and only then starts the relay. A failed start
leaves no relay or consumer runner running, and shutdown is bounded (see [Worker](../architecture/index.md#worker)). Re-applying the
topology is safe at any time: an unchanged stream is left alone, and a stream declared by an older
topology is updated in place, keeping its messages. Only the broker's "stream name already in use"
answer to the `add` leads to that `update`; any other failure (invalid configuration such as a
subject another stream owns, the broker unreachable) propagates with its original cause and no
update is attempted (TD-036). The two streams' subjects are disjoint, so every message lands in
exactly one of them. It never waits for Redis: the relay, the consumers and the sweeper
run during a Redis outage (see [waiting room](../architecture/waiting-room.md#redis-outage)). It serves
`GET /health`, which reports Redis separately (`"redis": "ok" | "unavailable"`) and the outbox's
`FAILED` rows (`"outbox": { "alert": boolean, "services": { booking, payment, notification } }`, each
`{ failed, oldestFailedAgeMs, failedTransitions }`, or `"unavailable"` when the database cannot be read)
and the broker's delivery figures for the admin dashboard (`"delivery": { "consumers": { <durable>:
{ lag, pendingAcks, redeliveries } | null }, "dlq": { size, oldestAgeMs } }`, or `"unavailable"` when
JetStream cannot answer). They come from `deliveryHealth(consumers, now)`, which the JetStream adapter
implements next to `MessageBus` (`DeliveryHealthProbe`): per durable consumer of the main stream
`num_pending` (lag: matching messages not yet delivered), `num_ack_pending` (delivered, not settled)
and `num_redelivered` (of those, the ones delivered more than once: a current figure, not a running
total), `null` for a consumer the broker does not know; for the DLQ stream its message count and the
age of its first retained message (`null` while empty). The worker reports its own consumers.
`status` stays `ok` and the response 200 whatever they report: a `FAILED` row is an operator alert, never a
liveness failure. `/health` is also Fly's liveness check (5 s timeout), so the three probes (Redis,
the Postgres outbox metrics, the NATS delivery figures) run concurrently, each with its own deadline
(`health.deadlinesMs`, default `DEFAULT_HEALTH_PROBE_DEADLINE_MS` = 2 s): a probe that rejects or
misses its deadline is reported `"unavailable"` and the others as usual, so a hung dependency (a
JetStream API call alone may wait the client's 5 s default) costs at most one deadline, never the
check. The web dashboard reads `/health` with an 800 ms timeout, so while a probe hangs it shows the
NATS figures as unavailable.

- **Relay** (`packages/messaging/src/outbox-relay.ts`): every 250 ms interval it claims a batch of 100 `PENDING`
  rows with `FOR UPDATE SKIP LOCKED` in one transaction, publishes each to `ta.<eventType>` with
  `Nats-Msg-Id = outbox id`, awaits the PubAck and marks the row `PUBLISHED`. A failed publish increments
  `attempts`, stores `lastError` and leaves the row `PENDING`. Only the oldest `PENDING` row of an aggregate is
  claimable (`NOT EXISTS` an older `PENDING` row), so order per aggregate holds across concurrent relays: later
  rows wait for an in-flight earlier one, or one whose publish failed transiently, at one row per aggregate per tick.
  Rows of a rolled-back transaction never exist for the relay.
  **Terminal failures** ([ADR 0022](../adr/0022-terminal-failed-outbox-events.md)): a publish failure is
  _permanent_ when it is specific to the row: the adapter throws `PermanentPublishError` with `reason`
  `no_stream` (no stream captures `ta.<eventType>`), `payload_too_large` (over the broker's `max_payload`) or
  `unserialisable`; everything else (connection lost, PubAck timeout, JetStream unavailable, stream full) is
  _transient_. A permanent failure also counts in `permanentFailures` and appends a `PUBLISH_FAILED` entry to
  `outbox_event_history`; when `permanentFailures` reaches the relay's cap (`maxPermanentFailures`, default
  `DEFAULT_MAX_PERMANENT_FAILURES` = 5) the row becomes `FAILED` (`failedAt` set, a `PENDING` → `FAILED`
  history entry), all in the claim transaction. A `FAILED` row keeps its payload and id, is never published,
  deleted or claimed again, and so **releases its aggregate**: later rows of that aggregate are published
  after it (consumers tolerate the gap, see ADR 0022's table). Transient failures never count, so a broker
  outage of any length never fails a row. After the transaction commits, the transition is logged once at
  `error` (`outbox event FAILED: permanent publish failures reached the cap`, with `service`, `outboxId`,
  `aggregateType`, `aggregateId`, `eventType`, `attempts`, `lastError`, never the payload); permanent
  failures before the cap log at `warn`. Recovery is the operator's requeue
  ([runbook](failed-outbox-event.md)): `requeueFailedOutboxEvent` (script `outbox:requeue`) moves one `FAILED`
  row back to `PENDING` under its original id. `measureOutboxFailures({ prisma, now })` returns per service
  the `FAILED` count, the oldest one's age and the transitions to `FAILED` in the history; `/health` reports
  them with an `alert` flag.
  A tick that fails outside a row's publish (claim query, mark or commit; e.g. the database is unreachable)
  rolls back, leaves its rows `PENDING`, and the loop retries on the next tick. It is logged at `error` with the
  cause (`outbox relay tick failed`), rate-limited by `failure-reporter.ts` per cause: the first failure of each
  cause, and then at most one line per 60 s window (`FAILURE_LOG_WINDOW_MS`) per cause while it persists, even
  when causes alternate, carrying `failures` and `suppressed` counts. At most 32 causes
  (`MAX_TRACKED_FAILURE_CAUSES`) keep a window; past that the least recently logged one is forgotten. The first successful tick after them logs `outbox relay recovered`
  at `info` with `failures` and `outageMs`. The relay takes an optional `now` clock for this.
- **Consumer runner** (`consumer-runner.ts`): durable pull consumer per consumer name (`AckWait` 30 s,
  no `BackOff`, `MaxDeliver` -1). Each message runs in one transaction that first inserts
  `processed_messages(consumer, messageId, streamSeq)` and then calls the handler. A unique violation of
  that insert is a duplicate and is acked; any handler error, including its own unique violation, rolls back
  and `nak`s with the ADR 0011 delay (1 s, 5 s, 30 s, 2 min). A message without `Nats-Msg-Id` is never processed;
  it is dead-lettered (below). An optional `beforeTransaction(message)` step runs first, outside the transaction, on every
  delivery (duplicates included); it is for slow work that must not hold the transaction (a provider's latency or
  call; it may commit its own short writes, never the dedupe row), must be safe to repeat, and a throw `nak`s like a
  handler failure. A handler may instead resolve to a `HandlerOutcome`
  (`{ outcome: "retry" | "poison", reason }`): the transaction rolls back (no `processed_messages` row, no
  outbox writes); `retry` is `nak`ed with the same delay, `poison` is dead-lettered (below).
  A handler (or `beforeTransaction`) failure is logged at `error` with the error, `deliveryCount` and the chosen
  `delayMs` before the `nak`.
  **Retry schedule:** every failed delivery ends in a delayed `nak` (a bare `nak` would redeliver immediately), with the
  delay picked by JetStream's `deliveryCount`, the only attempt counter (it also counts crashes and `AckWait`
  expiries and survives restarts): 1 s, 5 s, 30 s, 2 min, and 2 min for the 5th delivery; the 6th goes to the
  DLQ. The policy lives in code, not in a consumer `BackOff`. A handler (or `beforeTransaction` step) that
  can outlast `AckWait` calls `message.working()` to keep the delivery from expiring and being redelivered to
  another worker. AT-27, `consumer-runner-retry.test.ts`. A failed poll (the broker is unreachable for `fetch`, or anything else escapes a batch) is logged at
  `error` with the cause (`consumer poll failed`, same rate limit and `consumer poll recovered` line as the
  relay) and the loop polls again after 1 s.
  **DLQ gate and routing** ([ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md)): before `beforeTransaction` and the
  handler, a delivery past the retry budget (`deliveryCount > 5`, cause `retry_budget_exhausted`) is dead-lettered
  without running any consumer code, so a message that crashes the process every time still ends there. A runner
  given `schemas` (envelope schema per `version`, structurally a zod `safeParse`) also dead-letters, on the first
  delivery and without running the handler, a message that is not JSON or fails its version's schema
  (`schema_invalid`) or whose `version` has no schema (`unknown_version`); without `schemas` the gate checks only
  the budget. Every consumer in `createServiceConsumers` passes `schemas: { 1: envelopeSchema(<its subject's
  payload schema>) }` from `@ticketarena/contracts`, so in the worker a schema-invalid or unknown-version message
  is dead-lettered on its first delivery, before the payment provider step or any handler runs. A `poison` handler outcome is dead-lettered after the rollback
  (`handler_poison`, with the handler's reason). A message without `Nats-Msg-Id` has no safe dedupe key and is
  dead-lettered too, on its first delivery and without running the handler (`missing_msg_id`).
  **DLQ copy format** (`dead-letter.ts`): the copy is published to `ta.dlq.<consumer>` with the original data as
  its body, unchanged, and the metadata in headers: `TA-DLQ-Consumer`, `TA-DLQ-Subject`, `TA-DLQ-Stream-Seq`,
  `TA-DLQ-Delivery-Count`, `TA-DLQ-Cause` and `TA-DLQ-Reason` (one line, at most 1024 characters). There is no
  wrapper around the body: a wrapper grows it, and a message that only just fitted the broker's `max_payload`
  (headers count towards it) could then never be dead-lettered. When the original leaves less than 8 KiB under
  `max_payload` (the bus reports it, `MessageBus.maxPayloadBytes`) the body is split on character boundaries into
  parts that each fit, published one after another under `<dlq id>:part:<layout>:<n>/<total>` with `TA-DLQ-Part:
  <n>/<total>`, `TA-DLQ-Layout` (the part size in bytes) and `TA-DLQ-Digest` (SHA-256 hex of the whole original).
  The split offsets depend on the limit, so the layout is in the id: with the same limit a redelivery publishes
  the same ids, and after a `max_payload` change it stores a whole new layout instead of mixing new parts with an
  old part the broker deduplicates. `readDeadLetters` turns copies back into `DeadLetter`s (`consumer`, `subject`,
  `streamSeq`, `deliveryCount`, `error: { cause, message }`, `envelope`: the original data), joining parts per
  layout and checking the digest; an incomplete layout is ignored when the same copy has a complete one or
  was also stored unsplit (a retry once the original fits under a grown limit) (`dead-letter.test.ts`). The DLQ id is
  `dlq:<consumer>:<envelope id>` (the message's `Nats-Msg-Id`, which the relay sets to the envelope id); without
  one it is `dlq:<consumer>:main:<stream seq>:<first 16 hex of the data's SHA-256>`, which a redelivery keeps and
  which a recreated stream (its sequences restart) cannot give an unrelated message. The runner awaits the PubAck
  of every part, logs `message dead-lettered` at `error`, and only then `term`s. A crash between PubAck and `term`
  redelivers the message, which publishes the same ids again: no second copy (AT-28), **but only inside the DLQ
  stream's 10-minute duplicate window**: the broker deduplicates by msg id within that window only, so a
  redelivery later than that stores another copy (the redelivery after a crash comes after `AckWait`, 30 s, well
  inside it; `readDeadLetters` then returns both). A
  failed DLQ publish of any part (stream full, broker unreachable, too large, any error) logs `DLQ publish
  failed; retrying` and `nak`s with 2 min, never `term`; the redelivery republishes every part
  (AT-29). `consumer-runner-dlq.test.ts` (AT-28, AT-30), `consumer-runner-dlq-failure.test.ts` (AT-29). A
  dead-lettered message is replayed by recreating its durable with `--ignore-ack-floor` once the cause is fixed
  (below); there is no separate DLQ replay tool.
- **Consumer recovery** ([runbook](consumer-recovery.md), ADR 0011): `recreateConsumer` (`consumer-recovery.ts`,
  script `consumer:recover --consumer <name>`) deletes and recreates a durable of the main stream with the
  runner's settings, starting where the first applicable rule says: the ack floor + 1 when the durable exists
  with the same filter; otherwise, when `processed_messages` is a reliable checkpoint (the stream's first
  retained message is newer than its 14-day retention), the first retained message matching the filter that has
  no row for the consumer (a scan, because messages are processed out of order); otherwise the earliest retained
  message. Never a timestamp, never "highest processed minus a margin". The ack floor counts terminated
  (dead-lettered) messages as settled, so `ignoreAckFloor` skips rule 1 to replay them. It talks to the broker
  through the `ConsumerAdmin` port (`consumer-admin.ts`; adapter `connectJetStreamConsumerAdmin` in
  `jetstream-message-bus.ts`). The worker's `subscribe` accepts a durable recreated at a start sequence: when
  the broker answers "consumer already exists" it updates only the settings that may change (`AckWait`,
  `MaxDeliver`, filter) and keeps the position. AT-32, AT-33, AT-34, `consumer-recovery.test.ts`.
- **Outbox re-publish** (`outbox-republish.ts`, script `outbox:republish`): `republishOutboxEvents` moves one
  service's `PUBLISHED` rows with `publishedAt` in `[from, to)` back to `PENDING` (`publishedAt` cleared,
  `permanentFailures` reset, a `PUBLISHED` -> `PENDING` history entry with operator and reason, in one statement);
  the relay publishes them again under their original ids and consumers deduplicate them. `FAILED` and `PENDING`
  rows are never touched. The script refuses a `--from` earlier than 14 days before now (the replay window, where
  consumers still deduplicate). `outbox-republish.test.ts` (including a lost stream), `outbox-republish-main.test.ts`.
- **Retention** (`outbox-retention.ts`): `pruneRetention({ prisma, now })` deletes, in every service schema and
  in batches of 1,000, the outbox rows `PUBLISHED` more than `RETENTION_MS` (14 days) ago and the
  `processed_messages` rows older than that. It never deletes a `PENDING` or `FAILED` row, a row with
  `outbox_event_history` (so the history's CASCADE never fires), or a booking `unknown_order`
  `payment.refund_requested` whose orphan refund obligation does not exist yet (the reconciler's cutover catch-up
  still reads it). The DELETE re-checks `status` and `publishedAt` on the row it locks, so a row a concurrent
  re-publish moved to `PENDING` while the DELETE waited survives with its history (READ COMMITTED re-evaluates the
  condition on the committed row). The worker runs it hourly (`RETENTION_INTERVAL_MS`). `outbox-retention.test.ts`
  (including both orders of that race).
- **Port:** `MessageBus` hides the broker; `jetstream-message-bus.ts` is the only module importing
  `@nats-io/*` (a test enforces it). The adapter reconnects to the broker without limit (`maxReconnectAttempts: -1`;
  the client's default of 10 attempts would close the connection for good after about 20 s, stopping the
  relay until a restart), and takes optional `requestTimeoutMs` (PubAck and JetStream API, client default 5 s)
  and `reconnectTimeWaitMs` (client default 2 s) for tests. `message-bus.contract.ts` is the contract suite run against real NATS.

## Delivery guarantee and its bounds

Delivery is **at-least-once** end to end; Postgres is the source of truth and the outbox is the
recovery source. The bounds:

- **A full stream holds events back, never drops them.** Both streams use `discard: new` with a
  sized `max_bytes`, so once a stream is full the broker rejects the publish (`maximum bytes
  exceeded`) instead of discarding stored messages. The relay records the failure (`attempts`,
  `lastError`) and the row stays `PENDING`; it is published on a later tick once space frees
  (messages age out or are purged). AT-35, `stream-backpressure.test.ts`.
- **A permanently unpublishable event waits for an operator.** A row that fails permanently up to the
  cap becomes `FAILED` and is not delivered until it is requeued; later events of its aggregate are
  delivered before it (ADR 0022). It is never dropped: the row, its payload and its history stay in the
  outbox, `/health` raises its alert, and the requeue publishes it under its original id
  ([runbook](failed-outbox-event.md)). `outbox-failed.test.ts`, `outbox-outage.test.ts`.
- **7-day `max_age`.** A consumer more than 7 days behind loses the messages that aged out of
  `TICKETARENA` (30 days for the DLQ). Outbox rows outlive it (the retention job keeps `PUBLISHED` rows 14
  days after `publishedAt`), so `outbox:republish` can reach beyond the stream. Events published more than 14
  days ago cannot be recovered automatically ([runbook](consumer-recovery.md#the-14-day-limit)).
- **Single-node disk loss.** JetStream runs on one node and one volume (`sync_interval: always`
  protects against an OS crash, not against losing the disk). Losing the disk loses in-flight
  messages; they are recovered from the outbox
  ([ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md), [runbook](consumer-recovery.md#3-beyond-the-stream-re-publish-from-the-outbox)).

**Outbox lag** is the age of the oldest `PENDING` row: `measureOutboxLag({ prisma, service, now })`
(`outbox-lag.ts`) returns it in ms for one service's outbox, 0 when nothing is `PENDING`. It grows
while the relay cannot publish (broker down, stream full), which makes it the dashboard's signal
that events are waiting in the outbox. The admin dashboard does not show it yet.

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
| `payment.refund_requested` | booking saga handler; reconciler re-emit and `retryRefund` (same TX)    | `payment-refund`, `notification-refund-requested` | 1               |
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
buyer the refund was initiated (`notification-refund-requested`). The reconciler re-emits a stale
request, and `retryRefund` one in `MANUAL_REVIEW`, under a new event id with the original payload,
the payment's correlation id and `causationId: null`
([database](../database/index.md#refund-reconciler)).

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
channel (AT-43, for all five kinds). A record is unique on `(dedupeKey, channel)`: an order event
is keyed by its event id, a refund step by `paymentId` and template (`refund:<paymentId>:refund-initiated`
or `:refund-completed`). The reconciler's re-emits, operator retries and Payment's re-announcement
of an executed refund all carry new event ids, which Booking needs to recover a lost confirmation,
yet the buyer hears about each refund step once per channel. Two such events delivered at once
upsert the same row; whichever finishes first records it `SENT`, and a send that overlaps reuses
the row's id, so the provider's key dedupe absorbs it (`notification-handler.test.ts`, the
"concurrently" cases). A row this event got before the key existed (no key, written by a
pre-migration worker, or `event:<sourceEventId>` from the migration's backfill) is found by
`(sourceEventId, channel)` when its own event is redelivered, and promoted to the refund key in one
`UPDATE` conditional on the key it was read with, keeping its id as the provider key. A promoted
`PENDING` row is sent once under that id, a promoted `SENT` row is not sent again, and a later
re-announcement finds it by key and sends nothing new (`notification-dedupe-migration.test.ts`
runs this across the real migration). If another delivery already holds the key, the unique index refuses the
promotion and that winner's row is used, so nothing is sent under the old id; the old row keeps no
key and stays `PENDING` (only rows under the key are checkpointed `SENT`). Refund rows written
before migration `20261129000000_notification_dedupe_key` and never redelivered stay keyed by
their event, so a later re-announcement of such a refund can message the buyer once more.
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
`order.placed` that fails its envelope schema, or carries a version other than 1, is dead-lettered by
the DLQ gate on its first delivery (`schema_invalid` / `unknown_version`) without running the provider
latency step or the handler, so it writes nothing. An `order.placed` whose `paymentDeadline` has passed at
processing time (the injected clock) is skipped: acked as handled (its `processed_messages` row commits), logged
`order.placed skipped: its payment deadline has passed`, no attempt and no result; this limits the side effects
of a recovery replay (ADR 0011), and the sweeper expires the order.

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
row with `refundRequestedAt = refundLastRequestedAt = T`, `order.expired` and `payment.refund_requested` with reason
`late_capture`; the seats are never reclaimed for that payment, even while still free, AT-20);
`refund` (a capture the order cannot keep: on an `EXPIRED`, `CANCELLED` or `CONFIRMED` order, or
with a mismatched amount: order unchanged, `REFUND_REQUESTED` ledger row (its `refundReason` kept for the reconciler), `payment.refund_requested`
with the contact; an on-time capture on an `EXPIRED` order, reason `late_delivery`, is also counted
as `late_delivery_refund`, best-effort); `refund` `unknown_order` (a capture whose order no longer
exists; a demo reset keeps orders, so it is not a cause: no ledger row is possible, so the handler
inserts an orphan refund obligation (`orphan_refund_obligations`, primary key `paymentId`,
`INSERT … ON CONFLICT DO NOTHING`, keeping the capture's correlation id) and emits `payment.refund_requested` without contact only if
that insert wrote the row; a concurrent duplicate's insert waits on the uncommitted row and skips
it, so a redelivery or a duplicate under a new event id refunds it once); `noop` (ack; a non-final
failure, reason `attempt_failed`, is also counted as `payment_attempt_failed` in the event's Redis
counter hash, best-effort, and leaves the order open until its deadline); `retry` and `poison`
(unknown `orderId` on a failure) are returned to the runner as a `HandlerOutcome`. Any decision
the handler does not apply yet throws `... is not handled yet` and is retried, so captured money
is never dropped silently.

**Refund execution.** `payment-refund` (`service: "payment"`, `apps/worker/src/payment/refund-handler.ts`)
consumes `payment.refund_requested`: in the runner's transaction it inserts one `payment.refunds`
row (primary key `paymentId`, `INSERT … ON CONFLICT DO NOTHING`), reads the row back and emits
`payment.refunded` from it through the payment outbox. `processed_messages` absorbs a
redelivery; the primary key absorbs a duplicate request under a new event id, including a
concurrent one, whose insert waits on the uncommitted row and then skips it. So a payment is
refunded once (AT-23); a duplicate request re-announces that refund (`payment.refunded` with the
executed refund's `refundedAt`, amount and currency, a new event id), so booking recovers a lost
confirmation from the reconciler's re-emit and applies a repeat as `noop` `already_refunded`. Every request is executed, with or without a contact. `booking-saga-refunded` runs
`createPaymentSagaHandler` on `payment.refunded`: `transition` `refund_completed` moves the
payment's ledger row from `REFUND_REQUESTED` or `MANUAL_REVIEW` to `REFUNDED` by a conditional
update (zero rows throws), whatever the order's status (an `amount_mismatch` refund leaves the
order `PENDING_PAYMENT`); the order is unchanged and nothing is emitted. A repeat is `noop`
`already_refunded`. A `paymentId` missing from a known order's ledger is `poison`
(`unknown_payment`, or `refund_for_pending_order` on a `PENDING_PAYMENT` order). For an unknown
`orderId` the handler locks the payment's orphan refund obligation (an `unknown_order` refund has
no ledger row): `transition` `orphan_refund_completed` moves it from `REFUND_REQUESTED` or
`MANUAL_REVIEW` to `REFUNDED` by a conditional update (zero rows throws), emitting nothing; a repeat is `noop`
`already_refunded`; a payment with no orphan obligation is `poison` (`unknown_order`). The outbox
is never consulted, so the outcome does not depend on the request's outbox row still existing.

Relay and runner take a `service` (`booking` default, `payment` or `notification`) that selects the outbox and
`processed_messages` of that schema (ADR 0009); the worker runs one relay per outbox.

## Decided, not yet built

A dedicated DLQ replay tool is not built; a dead-lettered message is replayed by recreating its consumer
([runbook](consumer-recovery.md#replaying-a-dead-lettered-message)). Broker: NATS JetStream behind a `MessageBus` port ([ADR 0004](../adr/0004-nats-jetstream-message-bus.md)).
Retries, DLQ and consumer recovery: [ADR 0011](../adr/0011-delivery-retry-dlq-recovery.md).
Planned subjects and the envelope: [MVP spec, Messaging](../specs/ticketarena-mvp.md#messaging).
The catalogue above is filled in as slices emit events.
