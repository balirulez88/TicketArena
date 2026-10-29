# 0004: NATS JetStream behind a `MessageBus` port

- **Status:** Accepted
- **Date:** 2026-10-29
- **Spec:** [TicketArena MVP](../specs/ticketarena-mvp.md)

## Context

[ADR 0003](0003-transactional-outbox.md) left the broker open (Kafka vs NATS JetStream). The relay,
mock Payment and mock Notification run as modules of one worker app. Consumers need per-message
retry with delay, an explicit dead-letter path, and replay after recovery. Operations must stay
small enough for one developer: a local Docker Compose stack, a Fly.io deployment, and a Docker
sandbox for the agent harness that has no Docker of its own.

## Decision

Use **NATS JetStream**, reached only through a `MessageBus` port (publish with dedupe id, durable
pull subscription, ack / delayed nak / term / working). Application modules never import the NATS
client, so a Kafka adapter can be added later without touching them.

Topology is declared in code and applied idempotently by `ensureTopology()` on worker boot,
**before** the relay starts publishing:

| Stream            | Subjects                                               | Retention                                                                          |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `TICKETARENA`     | `ta.seat.>`, `ta.hold.>`, `ta.order.>`, `ta.payment.>` | `limits`, `max_age` 7d, sized `max_bytes`, `discard: new`                          |
| `TICKETARENA_DLQ` | `ta.dlq.>`                                             | `limits`, `max_age` 30d, sized `max_bytes`, `discard: new`, `duplicate_window` 10m |

The subject sets do not overlap. The server runs with `sync_interval: always`.

## Alternatives considered

- **Kafka (Redpanda / Confluent):** stronger brand recognition and a partitioned log, but no
  per-message delayed retry: retry topics and a DLQ topic must be hand-built. Heavy locally, and
  the serverless Kafka offering we would have used (Upstash Kafka) has been discontinued.
- **`interest` retention:** a message with no matching consumer at publish time is removed at once.
  Several of our subjects (`ta.seat.held`, `ta.hold.expired`) intentionally have no consumer, and a
  recreated consumer would lose its backlog. Rejected in favour of `limits`.
- **`discard: old`:** a full stream would silently drop the oldest, possibly unacked, messages.
  `discard: new` turns a full stream into publish errors, which the outbox absorbs as backpressure.
- **Default `sync_interval` (2 min):** an OS crash on our single node could lose PubAcked messages.

## Consequences

- Retry policy and DLQ routing live in one consumer runner (see [ADR 0011](0011-delivery-retry-dlq-recovery.md)).
- A consumer more than 7 days behind loses messages; consumer lag is a dashboard metric with an
  alert threshold well below that.
- `sync_interval: always` is server-wide and costs latency on every publish. The k6 suite measures
  it (default vs `always`); the setting stays unless the numbers say otherwise.
- Single-node JetStream on one Fly volume: losing the disk loses in-flight messages. The outbox is
  the recovery source (ADR 0011).
