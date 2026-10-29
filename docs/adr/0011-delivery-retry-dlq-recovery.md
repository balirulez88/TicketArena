# 0011: Delivery guarantees, retries, DLQ and consumer recovery

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

Consumers fail transiently, crash between work and ack, receive poison messages, and may need to be
recreated. JetStream's `BackOff` overrides `AckWait`, and a plain `nak` redelivers immediately.
Guiding principle: **replaying already processed messages is acceptable; silently skipping
unprocessed messages is not.**

## Decision

**Retry and DLQ**

- The single attempt counter is JetStream's `deliveryCount`; it also counts crashes and AckWait
  expiries. There is no separate application counter.
- Consumers use `AckWait` 30s (crash/hang detection only), no `BackOff`, and server
  `MaxDeliver = -1` so the server never drops a message on its own. The application budget is 5.
- Transient failure: `nak(delay)` with delay by delivery count: 1s, 5s, 30s, 2m. Long handlers call
  `working()`.
- The DLQ gate runs **before** the handler: `deliveryCount > 5` or a poison message (schema
  invalid, unknown version, `decide()` returns `poison`) skips the handler. A message that crashes
  the process every time still reaches the DLQ.
- DLQ routing: publish to `ta.dlq.<consumer>` with `Nats-Msg-Id = dlq:<consumer>:<envelope id>`,
  the original envelope, the error and the delivery count; await the PubAck; then `term`. If the
  DLQ publish fails, `nak(2m)`; never `term` without a confirmed DLQ copy.

**Delivery guarantee (stated honestly)**

At-least-once, with Postgres as the source of truth. Known bounds: a consumer more than 7 days
behind loses messages to `max_age`; single-node disk loss loses in-flight messages. A full stream
rejects publishes and the outbox holds the events (backpressure, not loss).

**Retention invariant:** outbox rows (`PUBLISHED` ones included) and `processed_messages` are kept
14 days, longer than the 7-day stream `max_age`, so recovery can always reach past the stream.

**Consumer recovery** (implemented by the consumer recreation script and runbook)

1. Prefer updating a consumer in place; recreate only when unavoidable.
2. **Ack floor available:** resume with `deliver_policy: by_start_sequence` at
   `ack_floor.stream_seq + 1`.
3. **Ack floor unavailable, reliable contiguous checkpoint exists:** scan the retained stream with
   the consumer's filter from the first retained sequence and check each message id against that
   consumer's `processed_messages`; resume at the **first sequence not guaranteed processed**.
   Never resume from "highest processed sequence minus a margin": messages are processed out of
   order, so a lower sequence can be unprocessed.
4. **No reliable checkpoint:** replay from the earliest retained message.
5. **Duplicates:** absorbed by `processed_messages`; the Payment consumer additionally skips orders
   whose payment deadline has passed, limiting side effects of large replays.
6. **Beyond stream retention:** re-publish from the outbox (rows moved back to `PENDING` for a
   time range; consumers dedupe). Events older than outbox retention (14 days) cannot be
   recovered automatically; this limit is documented in the runbook.

## Alternatives considered

- **`BackOff` on the consumer:** couples retry timing to server config and changes `AckWait`
  semantics; delayed `nak` keeps the policy in one place in code.
- **Finite `MaxDeliver` plus advisory listener for DLQ:** the server would drop the message if the
  advisory handler failed.
- **`by_start_time` for recreation:** an arbitrary time can skip unprocessed messages.

## Consequences

- Every consumer must be idempotent (ADR 0007) because recovery deliberately over-replays.
- Dashboard surfaces consumer lag, pending acks, redeliveries, DLQ size and age.
