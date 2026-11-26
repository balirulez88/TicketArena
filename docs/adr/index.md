# Architecture Decision Records

[← System map](../index.md)

Hard-to-reverse decisions with real alternatives. Copy [`0000-template.md`](0000-template.md),
number sequentially, and never rewrite an accepted decision; supersede it with a new ADR.

| ADR                                                             | Decision                                                        | Status                               |
| --------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------ |
| [0001](0001-turborepo-pnpm-monorepo.md)                         | Turborepo + pnpm monorepo                                       | Accepted                             |
| [0002](0002-redis-waiting-room.md)                              | Waiting room queue in Upstash Redis (refined by 0008)           | Accepted                             |
| [0003](0003-transactional-outbox.md)                            | Transactional outbox for async integrations (broker: 0004)      | Accepted                             |
| [0004](0004-nats-jetstream-message-bus.md)                      | NATS JetStream behind a `MessageBus` port                       | Accepted                             |
| [0005](0005-postgres-seat-state-row-locks.md)                   | Seat state in Postgres with pessimistic row locks               | Accepted                             |
| [0006](0006-booking-saga-payment-ledger.md)                     | Booking saga, captured-payment ledger, refund obligations       | Accepted                             |
| [0007](0007-three-layer-idempotency.md)                         | Three-layer idempotency                                         | Accepted                             |
| [0008](0008-waiting-room-admission.md)                          | Waiting-room ordering, admission rate and admission tokens      | Accepted                             |
| [0009](0009-per-service-schemas.md)                             | One database, one schema and one outbox per service             | Accepted                             |
| [0010](0010-real-infrastructure-tests.md)                       | Integration tests on real infrastructure, ports and contracts   | Accepted                             |
| [0011](0011-delivery-retry-dlq-recovery.md)                     | Delivery guarantees, retries, DLQ and consumer recovery         | Accepted                             |
| [0012](0012-identity-service-seam.md)                           | Anonymous sessions behind an `IdentityService` seam             | Accepted                             |
| [0013](0013-deployment-topology.md)                             | Deployment topology and CI                                      | Accepted; Redis line amended by 0025 |
| [0014](0014-sandbox-trust-boundary.md)                          | Sandbox trust boundary: bundles in, validated bundles out       | Accepted                             |
| [0015](0015-review-and-verification-isolation.md)               | Isolated host reviews and hardened, staged verification         | Accepted                             |
| [0016](0016-risk-based-debt-gate.md)                            | Risk-based technical debt gate                                  | Superseded in part by 0024           |
| [0017](0017-opt-in-lead-driver.md)                              | Opt-in lead driver for ticket execution                         | Accepted                             |
| [0018](0018-host-side-replay-of-a-rejected-candidate.md)        | Host-side replay of a rejected candidate                        | Accepted                             |
| [0019](0019-readiness-checks-for-the-lead-driver.md)            | Readiness checks for the lead driver                            | Accepted                             |
| [0020](0020-global-fail-closed-debt-hold.md)                    | Global, fail-closed debt hold (amends 0016)                     | Superseded in part by 0024           |
| [0021](0021-rejected-work-is-not-published-by-default.md)       | Rejected work is not published by default                       | Accepted                             |
| [0022](0022-terminal-failed-outbox-events.md)                   | Terminal FAILED outbox events release their aggregate           | Accepted (ticket 59 implements it)   |
| [0023](0023-quarantine-replay-namespaces-and-recovery-holds.md) | Quarantine replay namespaces and recovery holds                 | Accepted                             |
| [0024](0024-frozen-debt-register-check.md)                      | Frozen debt register is checked for changes                     | Accepted                             |
| [0025](0025-node-redis-over-tls-for-the-queue.md)               | Queue and worker counters use node-redis over TLS (amends 0013) | Accepted                             |
