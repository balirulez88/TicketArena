# 46: Worker startup cleanup when the HTTP server fails

**What to build:** a worker that cannot start, for example because its health port is taken, fails with a clear error and leaves nothing running: no relay or consumer loop keeps working against resources that are being closed. Resolves TD-034 in `docs/technical-debt.md`; must merge before ticket 38 (deployment), which is blocked by it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TD-034: `startWorker` with a port that is already in use rejects with an error naming the port, and after the rejection no relay or consumer runner is running (test: no further outbox publishes or message fetches happen after the rejection).
- [ ] TD-034: if any step of `startWorker` throws after a relay or runner has started, everything already started is stopped before the error propagates (test).
- [ ] `main.ts` turns a failed start into a logged error and a non-zero exit instead of an uncaught exception (test through the entry point's exported start function).
- [ ] The register entry TD-034 is `RESOLVED` with the verifying tests named in `Verification`.
