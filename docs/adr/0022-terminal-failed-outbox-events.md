# 0022: Terminal FAILED outbox events release their aggregate

- **Status:** Accepted (implemented by ticket 59)
- **Date:** 2026-11-14
- **Extends:** [0003](0003-transactional-outbox.md), [0011](0011-delivery-retry-dlq-recovery.md)

## Context

An outbox event that can never be published (TD-038) is retried forever today, and every later
event of its aggregate waits behind it. The maintainer decided the policy on 2026-11-14, when
ticket 59 was written; this ADR records that decision. Ticket 59 implements it and completes the
parts below that are marked as its own.

## Decision

- **Terminal state.** A row whose publish fails permanently becomes `FAILED` once its permanent
  failures reach a documented, injectable cap. A broker outage, however long, is never permanent
  and never counts towards the cap.
- **Never discarded, never delivered.** A `FAILED` row keeps its payload unchanged, its outbox
  id, aggregate and event type, its failure reason and attempts. It is never deleted, never marked
  `PUBLISHED`, and excluded from any retention rule.
- **The aggregate moves on.** Later events of the same aggregate may be published after an event
  of it has failed, consistent with the out-of-order-tolerant messaging architecture: the
  consumer-side dead-letter queue of ADR 0011 already accepts the same gap. Consumers either apply
  a later event correctly or refuse it without partial state change.
- **Visible and recoverable.** Every status change and permanent failure is recorded append-only;
  the transition is logged once at `error` and exposed through health metrics; an operator
  requeues a `FAILED` row by a documented procedure, with their name and a reason.

### What ticket 59 built

- **Permanent vs transient.** A failure is permanent only when it is specific to the row, and the
  JetStream adapter (`jetstream-message-bus.ts`) says so by throwing `PermanentPublishError`:
  `no_stream` (no stream's subjects capture `ta.<eventType>`: the PubAck request has no responder
  _and_ the JetStream API answers a stream lookup for the subject with "no stream matches subject",
  code 10059; a no-responders answer alone also means JetStream is down, so it stays transient),
  `payload_too_large` (the NATS client refuses a message over the server's `max_payload`), and
  `unserialisable` (the relay cannot `JSON.stringify` the payload; a `jsonb` payload always can, so
  this is a guard). Everything else is transient: connection lost, PubAck timeout, JetStream
  unavailable, stream full (`maximum bytes exceeded`). The errors that tell them apart are pinned
  against real NATS by `publish-failure-classification.test.ts`.
- **The cap.** `DEFAULT_MAX_PERMANENT_FAILURES` = 5 permanent failures, injectable per relay
  (`maxPermanentFailures`). Counted in `permanentFailures`, separate from `attempts` (which counts
  every failure) and reset by a requeue. Five deterministic failures are a few seconds of relay
  ticks: enough to ride out a stream being redeclared during a deploy, short enough that the
  aggregate is not held for long.
- **The `FAILED` state and what it keeps.** `status = 'FAILED'` with `failedAt`, `attempts` and
  `lastError`; the payload (unchanged, byte for byte), outbox id, aggregate and event type are kept;
  `publishedAt` stays null. The relay claims only `PENDING` rows, so a `FAILED` row is never claimed
  again and no longer counts as "an earlier row of the aggregate": the aggregate is released.
- **History.** `outbox_event_history` (one per service schema) gets an insert-only entry for every
  permanent failure and every status change (`PENDING` → `FAILED`, `FAILED` → `PENDING` with
  operator and reason), with time, attempt number and error.
- **Alert, metrics, recovery.** One `error` line per transition (after commit, without the payload);
  `measureOutboxFailures` and the worker's `/health` (`outbox.alert`); `requeueFailedOutboxEvent` and
  the `outbox:requeue` script, which refuse any row that is not `FAILED`. Runbook:
  [docs/messaging/failed-outbox-event.md](../messaging/failed-outbox-event.md).

### When a later event arrives before an earlier one

Per aggregate with more than one event type in one outbox, what each consumer does when the later
event is delivered while the earlier one is `FAILED`. A new multi-event aggregate, or a new consumer
of one of these events, adds a row here and a test in
`apps/worker/src/failed-outbox-consumer-flow.test.ts`.

| Outbox, aggregate        | Earlier → later events                                                   | Consumer of the later event                                                                                                                                                  | Consumer of the earlier event, when requeued                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| booking, `order`         | `order.placed` → `order.confirmed` / `order.cancelled` / `order.expired` | `notification*`: applies it (each notification depends only on its own event)                                                                                                | `payment`: applies it (captures; it reads no booking state). A capture for an order already final is then refunded by the saga, as for any late capture |
| booking, `hold`          | `seat.held` → `hold.released` / `hold.expired`                           | none (no consumer yet)                                                                                                                                                       | none                                                                                                                                                    |
| payment, `payment`       | `payment.succeeded` / `payment.failed` → `payment.refunded`              | `booking-saga-refunded`: refuses it (`poison`: the payment is not in the ledger; rolled back, redelivered) until the capture is applied; `notification-refunded`: applies it | `booking-saga`: applies it, after which the redelivered `payment.refunded` applies too                                                                  |
| booking, `order_payment` | `payment.refund_requested` → its re-emits (one event type)               | `payment-refund`, `notification-refund-requested`: apply it once per `paymentId`                                                                                             | the same consumers deduplicate it by `paymentId` (one refund, one notification per step)                                                                |

Proved for `order` (with `order.confirmed` and `order.expired`) and `payment` by
`failed-outbox-consumer-flow.test.ts`: the end state equals in-order delivery, each effect once.

## Alternatives considered

- **Hold the aggregate until a human acts.** Strict ordering, but one poison event stops every
  later event of its aggregate indefinitely.
- **Drop or dead-letter the outbox row.** Loses the event or moves it out of the transaction's
  audit trail; the decision requires it to stay visible and recoverable where it was written.

## Consequences

- Consumers of multi-event aggregates must tolerate a later event arriving first; ticket 59 proves
  this per consumer.
- Operators get a new alert and a runbook; a `FAILED` row is a standing signal until it is acted
  on.
