# 46: Worker startup cleanup when the HTTP server fails

**What to build:** a worker that cannot start, for example because its health port is taken, fails with a clear error and leaves nothing running: no relay or consumer loop keeps working against resources that are being closed; and a worker asked to stop always exits within a bound, reporting any failure. Resolves TD-034 and TD-035 in `docs/technical-debt.md`; must merge before ticket 38 (deployment), which is blocked by both.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [ ] TD-034: `startWorker` with a port that is already in use rejects with an error naming the port, and after the rejection no relay or consumer runner is running (test: no further outbox publishes or message fetches happen after the rejection).
- [ ] TD-034: if any step of `startWorker` throws after a relay or runner has started, everything already started is stopped before the error propagates (test).
- [ ] `main.ts` turns a failed start into a logged error and a non-zero exit instead of an uncaught exception (test through the entry point's exported start function).
- [ ] TD-035: when stopping the worker fails (a relay, runner or bus close rejects), the shutdown path logs the error and exits non-zero instead of leaving an unhandled rejection (test through the entry point's exported shutdown function with an injected failing component).
- [ ] TD-035: shutdown is bounded: when a component's stop does not settle within a documented, injectable deadline (for example a relay tick holding its claim transaction), the worker logs which component did not stop and exits non-zero at the deadline (test with a component whose stop never settles; no fixed sleep, the deadline is injected). Sabotage: removing the deadline makes the test exceed its timeout.
- [ ] The register entries TD-034 and TD-035 are `RESOLVED` with the verifying tests named in `Verification`.
