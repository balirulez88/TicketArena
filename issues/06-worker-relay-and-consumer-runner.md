# 06: Worker app, outbox relay and consumer runner

**What to build:** a long-running worker app publishes committed outbox rows to NATS JetStream and hosts durable consumers that process each message once, so an `order.placed` written by checkout appears in the stream exactly once per row and a consumer sees it. Spec: Messaging; ADR 0004, ADR 0007.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The `messaging` package exposes a `MessageBus` port and a JetStream adapter; application modules never import the NATS client.
- [ ] `ensureTopology()` idempotently creates `TICKETARENA` (`ta.seat.>`, `ta.hold.>`, `ta.order.>`, `ta.payment.>`; limits, 7 days, sized, `discard: new`) and `TICKETARENA_DLQ` (`ta.dlq.>`; limits, 30 days, sized, `discard: new`, duplicate window 10 min) before the relay starts.
- [ ] The relay polls every 250 ms with `FOR UPDATE SKIP LOCKED` (batch 100), publishes with `Nats-Msg-Id = outbox id`, awaits PubAcks, marks rows `PUBLISHED`; publish errors increment `attempts`/`lastError`.
- [ ] The consumer runner provides durable pull consumers (`AckWait` 30s, no `BackOff`, `MaxDeliver -1`), inserts `processed_messages(consumer, messageId, streamSeq)` in the handler's transaction, and acks a unique violation as a duplicate.
- [ ] The worker exposes `/health`.
- [ ] AT-26: committed rows are published once each; rows from a rolled-back transaction never are.
- [ ] AT-31: a crash after commit but before ack leads to a redelivery that is acked as a duplicate with no second side effect.
- [ ] A `MessageBus` contract suite runs against real NATS.
- [ ] `docs/messaging` and `docs/architecture` describe the worker and the relay.
