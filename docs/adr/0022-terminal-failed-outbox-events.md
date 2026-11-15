# 0022: Terminal FAILED outbox events release their aggregate

- **Status:** Accepted (implementation: ticket 59, not yet implemented)
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

Ticket 59 adds, here: what counts as a permanent failure, the cap's value, and the table of what
each consumer does when a later event of a multi-event aggregate arrives before an earlier one.

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
