# 63: Redis outages do not hang booking or the worker

**What to build:** Redis decides only queue order and admission, never seat state (ADR 0005), so a Redis outage must not take anything else down with it. Today the worker awaits `redis.connect()` before it starts, so a Redis outage also stops the outbox relay, the consumers and the hold sweeper; the web queue store keeps a client whose first `connect()` failed, and a down Redis can hang queue procedures and booking's best-effort slot release. Raised in the review of PR #9 and in run 202611181233's follow-ups.

**Blocked by:** 30, 31

**Status:** ready-for-agent

- [ ] The worker starts the relay, the consumers and the sweeper without waiting for Redis; the admission ticker and reaper keep retrying, and `/health` reports Redis separately.
- [ ] Every Redis client the apps create has a bounded connect timeout and command timeout, and does not queue commands while disconnected; a client whose first connect fails is destroyed and replaced on the next use.
- [ ] `placeOrder` with Redis down commits the order and returns within a bounded time; the slot release failure is logged.
- [ ] Queue procedures with Redis down fail within a bounded time with a clear error, not a hang.
- [ ] Integration tests cover each case against a Redis that is stopped or unreachable (for example a closed port), not a mock of our modules.
- [ ] Admission check during an outage (answer to ticket 31's third question in `.devflow/questions.md`): `admittedProcedure` always verifies the token's signature, that its algorithm is HS256 (any other algorithm, `none` included, is refused), `exp`, `sub` against the current session and `eid` against the requested event. Only when Redis is unreachable (a connection error or the bounded command timeout, not a `false` answer) does it skip the `jti` revocation lookup and let the call through; it logs a warning naming the event, never the token.
- [ ] With Redis reachable, a token whose `jti` is missing from the admitted set or revoked is `FORBIDDEN`, as today.
- [ ] A token with a bad signature, another algorithm, a past `exp`, another session or another event is `FORBIDDEN` whether Redis is reachable or not.
- [ ] With Redis unreachable, no new admission is issued: `queue.join` and `queue.status` mint no admission token and fail within a bounded time.

**Documentation deliverable (reviewed, not test-verified):** an amendment to ADR 0008 and the waiting-room docs state that during a Redis outage a revoked admission token can stay usable until its fixed expiry (at most 30 minutes), that the outage issues no new admission, and that seat correctness is unaffected because seat state lives in Postgres (ADR 0005).
