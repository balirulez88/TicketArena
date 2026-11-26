# 0025: The waiting-room queue and worker counters use node-redis over TLS

- **Status:** Accepted (by the maintainer, 2026-11-26)
- **Date:** 2026-11-24
- **Amends:** [0013](0013-deployment-topology.md): its Redis line ("Upstash, REST adapter in
  web and worker")

## Context

ADR 0013 chose Upstash with its REST adapter in both the web app and the worker. When the
deployment was built (ticket 38), only part of the code followed that: the web app's booking
counters and the admin rate limiter use the Upstash REST API, but the waiting-room queue (web and
worker) and the worker's saga counters use node-redis. Production points node-redis at Upstash's
TLS Redis endpoint (`REDIS_URL=rediss://default:<token>@<host>:6379`), the same database and keys
the REST clients use.

The node-redis path is the one hardened for outages (ticket 63, PR #16 review): every connect and
reconnect is bounded, every command has its own deadline, a handshake error reply fails closed,
and an outage becomes `RedisUnavailableError`, which the queue procedures map to
`SERVICE_UNAVAILABLE` and `admittedProcedure` uses to skip only the revocation lookup. The REST
queue store (`createUpstashQueueStore`) passes the queue contract tests, but its failures are not
mapped that way, so switching to it would weaken outage behaviour that was just reviewed.

## Decision

- The waiting-room queue in web and worker, and the worker's saga counters, use node-redis over
  TLS (`rediss://`) against Upstash, through the bounded lazy connection
  (`createBoundedRedis`, `createWorkerRedis`).
- The web app's booking counters and the admin rate limiter keep the Upstash REST API.
- Both transports reach the same Upstash database. Key ownership is unchanged: each feature owns
  its key prefix, whichever transport it uses.
- `REDIS_URL` is `rediss://` in production (set by the one-time setup in
  `docs/operations/deployment.md`); plain `redis://` is for local and CI only. The validators
  accept both schemes.

## Alternatives considered

- **Finish the REST wiring (ADR 0013 as written):** one transport everywhere and no long-lived TCP
  connection from Vercel functions. Rejected for now: it needs the REST store's outage errors
  mapped to `SERVICE_UNAVAILABLE` and the revocation fail-open rule re-proved, with no measured
  problem to solve.
- **node-redis everywhere:** the rate limiter and counters already work over REST, and REST suits
  short-lived functions; moving them gains nothing.

## Consequences

- Two client libraries and two credentials (`REDIS_URL` and the REST URL and token) for one
  Upstash database; a credential rotation updates both (deployment runbook).
- A Vercel function instance holds one TLS connection to Upstash while it is warm, connected on
  first use. Upstash's connection limit must stay above the expected number of warm instances
  plus one worker; for the demo's traffic this is far from the free tier's limit.
- Outage behaviour of the queue and admission check stays as proved by ticket 63's tests. If the
  REST store is ever adopted for the queue, it must pass the same outage tests first, and this
  ADR is superseded.
