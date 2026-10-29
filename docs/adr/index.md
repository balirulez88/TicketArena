# Architecture Decision Records

[← System map](../index.md)

Hard-to-reverse decisions with real alternatives. Copy [`0000-template.md`](0000-template.md),
number sequentially, and never rewrite an accepted decision; supersede it with a new ADR.

| ADR                                           | Decision                                                      | Status   |
| --------------------------------------------- | ------------------------------------------------------------- | -------- |
| [0001](0001-turborepo-pnpm-monorepo.md)       | Turborepo + pnpm monorepo                                     | Accepted |
| [0002](0002-redis-waiting-room.md)            | Waiting room queue in Upstash Redis (refined by 0008)         | Accepted |
| [0003](0003-transactional-outbox.md)          | Transactional outbox for async integrations (broker: 0004)    | Accepted |
| [0004](0004-nats-jetstream-message-bus.md)    | NATS JetStream behind a `MessageBus` port                     | Accepted |
| [0005](0005-postgres-seat-state-row-locks.md) | Seat state in Postgres with pessimistic row locks             | Accepted |
| [0006](0006-booking-saga-payment-ledger.md)   | Booking saga, captured-payment ledger, refund obligations     | Accepted |
| [0007](0007-three-layer-idempotency.md)       | Three-layer idempotency                                       | Accepted |
| [0008](0008-waiting-room-admission.md)        | Waiting-room ordering, admission rate and admission tokens    | Accepted |
| [0009](0009-per-service-schemas.md)           | One database, one schema and one outbox per service           | Accepted |
| [0010](0010-real-infrastructure-tests.md)     | Integration tests on real infrastructure, ports and contracts | Accepted |
| [0011](0011-delivery-retry-dlq-recovery.md)   | Delivery guarantees, retries, DLQ and consumer recovery       | Accepted |
| [0012](0012-identity-service-seam.md)         | Anonymous sessions behind an `IdentityService` seam           | Accepted |
| [0013](0013-deployment-topology.md)           | Deployment topology and CI                                    | Accepted |
