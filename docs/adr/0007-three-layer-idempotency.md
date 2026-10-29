# 0007: Three-layer idempotency

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

Clients retry on timeouts, the outbox delivers at least once, JetStream redelivers after crashes,
and the mock payment can publish duplicates on purpose. No retry may cause a second state change
or a second side effect.

## Decision

1. **Client requests:** `placeOrder` takes a client-generated UUID `idempotencyKey`, unique per
   `(sessionId, idempotencyKey)` together with a hash of the canonical request. The same key with
   the same hash returns the original result; the same key with a different hash is rejected with
   `IDEMPOTENCY_KEY_REUSED`. Concurrent duplicates are resolved by the unique constraint.
2. **Consumers:** a `processed_messages(consumer, messageId, streamSeq)` row is inserted in the
   **same transaction** as the state change and the outbox writes it causes. A unique violation
   means the message was already handled: roll back and ack.
3. **State transitions:** the handler locks the aggregate, reads its state, and calls a pure
   `decide(state, event)` returning `transition | noop | refund | retry | poison`. Writes are
   conditional on the expected state as a guard. A zero-row update is never treated as success.

Publishing carries `Nats-Msg-Id = outbox id`, so broker-side dedupe also suppresses relay replays
within the duplicate window. Side-effect tables are unique on their natural key: payments on
`(orderId, attemptNo)`, refunds on `paymentId`, notifications on `(sourceEventId, channel)`.

## Alternatives considered

- **Broker dedupe only:** bounded by the duplicate window; does not cover consumer redelivery.
- **Idempotency via natural keys only:** fails for events that legitimately repeat a type with
  different meaning (a second payment on the same order).

## Consequences

- `processed_messages` must outlive stream retention (kept 14 days vs 7) so it can serve as the
  recovery checkpoint (ADR 0011).
- External notification delivery stays **at-least-once** unless the provider honours our
  idempotency key; documented in the spec.
