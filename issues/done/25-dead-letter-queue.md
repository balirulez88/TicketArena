# 25: Dead-letter queue routing

**What to build:** a message that exhausts its retry budget, or is poison, moves to the DLQ exactly once and is never terminated without a confirmed DLQ copy. Spec: Messaging (consumer runner); ADR 0011.

**Blocked by:** 24, 49 (Prisma schema drift), 59 (terminal outbox failures)

**Status:** done

**Completed:** 2026-11-27 on devflow/run-202611271130 (run 202611271130)

**Status reason:** retry, DLQ and recovery after the MVP (2026-11-18)

- [ ] The DLQ gate runs before the handler: `deliveryCount > 5`, schema-invalid or unknown version → DLQ without invoking the handler; a `decide` poison outcome also routes to the DLQ.
- [ ] DLQ publish to `ta.dlq.<consumer>` with `Nats-Msg-Id = dlq:<consumer>:<envelope id>`, carrying the original envelope, error and delivery count; await PubAck; then `term`.
- [ ] DLQ publish failure → `nak(2m)`, never `term`.
- [ ] AT-28: budget exhausted → exactly one DLQ copy; a simulated crash between DLQ publish and `term` creates no second entry.
- [ ] AT-29: DLQ publish failure → the message is redelivered, not terminated.
- [ ] AT-30: poison message → DLQ on first delivery, handler not invoked.

## Review fix (PR #21): ids and size limits

A HIGH review finding: a message without `Nats-Msg-Id` was terminated with no DLQ copy, and a message
near the broker's `max_payload` could never fit its JSON DLQ wrapper. The DLQ copy now carries the
original data unchanged as its body with the metadata in `TA-DLQ-*` headers, split into parts when it
would not fit beside them; a message without an id is dead-lettered under
`dlq:<consumer>:main:<stream seq>:<data digest>`. `term` follows the PubAck of every part. New tests,
each seen failing first against real NATS:

- `packages/messaging/src/consumer-runner-dlq.test.ts` :: "dead-letters a message without a Nats-Msg-Id under an id derived from its stream sequence, once across a crash before term"
- `packages/messaging/src/consumer-runner-dlq.test.ts` :: "preserves a message just under the broker's max_payload in full before term, once across a crash before term"
- `packages/messaging/src/consumer-runner-dlq-failure.test.ts` :: "naks a message without a Nats-Msg-Id with 2 minutes and never terms it while its DLQ copy is unconfirmed"
