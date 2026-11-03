# 06: Worker app, outbox relay and consumer runner

**What to build:** a long-running worker app publishes committed outbox rows to NATS JetStream and hosts durable consumers that process each message once, so an `order.placed` written by checkout appears in the stream exactly once per row and a consumer sees it. The `messaging` package already exists as scaffolding (ticket 42); build into it. Spec: Messaging; ADR 0004, ADR 0007.

**Blocked by:** 05, 42

**Status:** ready-for-agent

- [ ] The `messaging` package exposes a `MessageBus` port and a JetStream adapter; a test fails if any module outside the adapter (tests excepted) imports `@nats-io/*`.
- [ ] `ensureTopology()` idempotently creates `TICKETARENA` (`ta.seat.>`, `ta.hold.>`, `ta.order.>`, `ta.payment.>`; limits, 7 days, sized, `discard: new`) and `TICKETARENA_DLQ` (`ta.dlq.>`; limits, 30 days, sized, `discard: new`, duplicate window 10 min), verified against real NATS; a test of the worker's startup proves topology is ensured before the relay's first poll.
- [ ] The relay's defaults are a 250 ms polling interval and a batch of 100, each asserted by a test (one tick over more than 100 pending rows publishes exactly 100); it publishes with `Nats-Msg-Id = outbox id` (asserted on the stored stream message), awaits PubAcks, marks rows `PUBLISHED`; publish errors increment `attempts`/`lastError`.
- [ ] The relay claims rows with `FOR UPDATE SKIP LOCKED`: a test against real Postgres runs two relays at the same time over one set of pending rows, holds the first relay's claim open while the second ticks, and proves the second claims none of the first's rows and every row is published exactly once.
- [ ] The consumer runner provides durable pull consumers (`AckWait` 30s, no `BackOff`, `MaxDeliver -1`, asserted from the consumer info on real NATS), inserts `processed_messages(consumer, messageId, streamSeq)` in the handler's transaction, and acks only a unique violation of `processed_messages` as a duplicate: a handler's own unique violation is not acked (test).
- [ ] A message without a `Nats-Msg-Id` is never processed under an empty or shared dedupe key (test).
- [ ] The worker exposes `/health`.
- [ ] AT-26: committed rows are published once each; rows from a rolled-back transaction never are.
- [ ] AT-31: a crash after commit but before ack leads to a real JetStream redelivery of the unacked message that is acked as a duplicate with no second side effect.
- [ ] A `MessageBus` contract suite in `packages/messaging` runs against real NATS and covers topology, publish dedupe, consume, ack and redelivery.
- [ ] `docs/messaging` and `docs/architecture` describe the worker and the relay; a docs test fails if either stops naming the worker, the relay, its 250 ms interval and batch of 100, and the consumer runner.
