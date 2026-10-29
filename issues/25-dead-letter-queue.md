# 25: Dead-letter queue routing

**What to build:** a message that exhausts its retry budget, or is poison, moves to the DLQ exactly once and is never terminated without a confirmed DLQ copy. Spec: Messaging (consumer runner); ADR 0011.

**Blocked by:** 24

**Status:** ready-for-agent

- [ ] The DLQ gate runs before the handler: `deliveryCount > 5`, schema-invalid or unknown version → DLQ without invoking the handler; a `decide` poison outcome also routes to the DLQ.
- [ ] DLQ publish to `ta.dlq.<consumer>` with `Nats-Msg-Id = dlq:<consumer>:<envelope id>`, carrying the original envelope, error and delivery count; await PubAck; then `term`.
- [ ] DLQ publish failure → `nak(2m)`, never `term`.
- [ ] AT-28: budget exhausted → exactly one DLQ copy; a simulated crash between DLQ publish and `term` creates no second entry.
- [ ] AT-29: DLQ publish failure → the message is redelivered, not terminated.
- [ ] AT-30: poison message → DLQ on first delivery, handler not invoked.
