# 46: Worker startup cleanup when the HTTP server fails

**What to build:** a worker that cannot start, for example because its health port is taken, fails with a clear error and leaves nothing running: no relay or consumer loop keeps working against resources that are being closed; and a worker asked to stop always exits within a bound, reporting any failure. Resolves TD-034 and TD-035 in `docs/technical-debt.md`; must merge before ticket 38 (deployment), which is blocked by both.

**Type:** fix

**Blocked by:** None (can start immediately)

**Status:** done

**Completed:** 2026-11-26 on devflow/run-202611261713 (run 202611261713)

**Status reason:** hardening, after the MVP (scope cut 2026-11-18)

- [x] TD-034: `startWorker` with a port that is already in use rejects with an error naming the port, and after the rejection no relay or consumer runner is running (test: no further outbox publishes or message fetches happen after the rejection).
- [x] TD-034: if any step of `startWorker` throws after a relay or runner has started, everything already started is stopped before the error propagates (test).
- [x] `main.ts` turns a failed start into a logged error and a non-zero exit instead of an uncaught exception (test through the entry point's exported start function).
- [x] TD-035: when stopping the worker fails (a relay, runner or bus close rejects), the shutdown path logs the error and exits non-zero instead of leaving an unhandled rejection (test through the entry point's exported shutdown function with an injected failing component).
- [x] TD-035: shutdown is bounded: when a component's stop does not settle within a documented, injectable deadline (for example a relay tick holding its claim transaction), the worker logs which component did not stop and exits non-zero at the deadline (test with a component whose stop never settles; no fixed sleep, the deadline is injected). Sabotage: removing the deadline makes the test exceed its timeout.
- [x] The evidence that resolves TD-034 and TD-035 is recorded in this ticket's `Verification` section. Per [ADR 0024](../../docs/adr/0024-frozen-debt-register-check.md) and the maintainer's answer to Q9, the frozen `docs/technical-debt.md` is not edited.
- [x] Cleanup after a failed start is bounded too, and the resources are opened inside the protected start path (review of PR #19, Q10). A stop that never settles cannot hold back the start error, and the log names the stuck component. If the NATS connect fails, or startup fails after it, the resources opened so far are closed.

## Verification (TD-034, TD-035)

Startup (TD-034), `apps/worker/src/worker-startup.test.ts`:

- `rejects naming a health port that is in use, and leaves no relay, consumer runner or reconciler running`
- `stops the relay and the runners already started when a later step throws, before the error propagates`
- `rejects within its stop deadline when a started component's stop never settles, naming it`: this is the bounded partial-start cleanup. `startWorker` takes a `stopBudget` option, which defaults to a fresh `DEFAULT_SHUTDOWN_DEADLINE_MS` budget. The sabotage check: without the deadline, the test runs into its 5 s timeout.

Entry point and shutdown (TD-034, TD-035), `apps/worker/src/lifecycle.test.ts`:

- `startWorkerProcess` › `turns a failed start into a logged error, closes the resources and exits non-zero`
- `startWorkerProcess` › `closes what was opened before the NATS connect failed, and exits non-zero`
- `startWorkerProcess` › `bounds the cleanup of a failed start by the 25 s budget, naming the resource that did not close` (uses fake time)
- `startWorkerProcess` › `spends one 25 s budget on the worker's cleanup and the resources: a stuck component and a stuck resource exit at 25 s, not 50 s` (uses fake time). A failed start has one budget: the clock starts at the first stop, and `startWorker`'s cleanup and the resource closes both spend from it.
- `shutdownWorkerProcess (TD-035)` › `logs a component whose stop rejects, still closes the rest, and exits non-zero`
- `shutdownWorkerProcess (TD-035)` › `exits non-zero at the deadline, naming the component that did not stop`
- `shutdownWorkerProcess (TD-035)` › `bounds shutdown by default within Fly's 30 s kill_timeout`. There is one 25 s budget (`DEFAULT_SHUTDOWN_DEADLINE_MS`, Q10), and the deadlines are injectable (`deadlineMs`, `stopBudget`).
