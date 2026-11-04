# 44: Payment latency outside the runner transaction

**What to build:** the mock payment provider's simulated latency never runs inside the consumer runner's database transaction, so a slow provider neither holds a pooled connection idle nor times the transaction out into an endless redelivery. Resolves TD-051 in `docs/technical-debt.md`; must merge before ticket 17 and ticket 27, which change payment and saga handling and are blocked by it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-051: with a configured latency longer than the runner's interactive-transaction timeout (Prisma's default 5 s), an `order.placed` is captured exactly once and `payment.succeeded` is emitted once, on the first delivery (integration test against real Postgres and NATS with a real sleep, not the sleep stub).
- [ ] TD-051: no database transaction is open while the provider latency elapses (a test observes that the handler's transaction starts only after the wait).
- [ ] A redelivered `order.placed` whose payment was already captured is still a duplicate: the latency step never causes a second capture or a second `payment.succeeded`.
- [ ] Where the latency now happens and why (outside the transaction, before dedupe-and-capture) is documented in `docs/messaging` and verified by the docs test.
- [ ] The register entry TD-051 is `RESOLVED` with the verifying tests named in `Verification`.
