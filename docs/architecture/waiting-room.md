# Waiting room

[← Architecture](index.md)

Decisions: [ADR 0002](../adr/0002-redis-waiting-room.md), [ADR 0008](../adr/0008-waiting-room-admission.md).
Code: `packages/waiting-room` (module), `apps/web/src/server/routers/queue.ts` (API),
`apps/web/src/server/queue-store.ts` (wiring).

Built so far: join, status and leave, with fair ordering, on two interchangeable `QueueStore`
adapters (node-redis and Upstash REST). Admission (token bucket, `maxActive`, active slots,
admission tokens, gating `holdSeats`) arrives with tickets 30 and 31.

## Module surface

| Export                          | Role                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `QueueService`                  | `join(event, sessionId)`, `status(eventId, sessionId)`, `leave(eventId, sessionId)`                      |
| `QueueStore` (port)             | `join(eventId, member, score)`, `position(eventId, member)`, `leave(eventId, member)`; positions 1-based |
| `createRedisQueueStore`         | node-redis adapter over the narrow `RedisQueueClient` (`eval`, `zRank`); options: `prefix`               |
| `createUpstashQueueStore`       | Upstash REST adapter (`fetch`); options: `url`, `token`, `prefix`, `timeoutMs` (default 2000)            |
| `AdmissionPolicy` (port)        | `isQueueActive(event, now)`                                                                              |
| `createScheduleAdmissionPolicy` | MVP policy: active from `queueOpensAt` (inclusive) to `queueClosesAt` (exclusive)                        |
| `Clock`, `Random`               | Injected; the module never reads the system clock or `Math.random`. `Random.next()` returns `[0, 1)`     |

`join` results: outside the queue window `{ status: "ADMISSIBLE" }` (immediate admission
eligibility; nothing is queued), else `{ status: "QUEUED", position, etaSeconds }`. `status`
returns `QUEUED` with position and ETA, or `NOT_QUEUED`. `leave` returns `{ left }`.
ETA = `ceil(position / admitRatePerSecond)`; the web app assumes 10 admissions per second until
the admission ticker makes the rate real.

## Redis keys

All keys start with the store's configurable `prefix` (the web app uses none; each test file uses
its own). `{eventId}` is a hash tag so an event's keys share one cluster slot, which multi-key
scripts need.

| Key                                      | Type    | Content                                             |
| ---------------------------------------- | ------- | --------------------------------------------------- |
| `<prefix>waiting-room:{<eventId>}:queue` | ZSET    | member = session id, score = join score (see below) |
| `<prefix>waiting-room:{<eventId>}:seq`   | counter | source of the `1 + sequence` scores of later joins  |

## Scripts

Every mutation is one Lua script, so it is atomic against concurrent joins on other connections.
Reads (`position`) are a single `ZRANK`. Both adapters share the scripts and the key layout
(`src/queue-scripts.ts`), so they read and write the same data.

- **join**: if the member has no score, its score is the given pre-queue value, or
  `1 + INCR seq` for a later join; then `ZADD NX`; returns the member's rank.
- **leave**: `ZREM`; returns whether the member was queued.

The node-redis adapter sends `EVAL`. The Upstash adapter sends `EVALSHA` (SHA-1 computed
locally) and falls back to `EVAL` on `NOSCRIPT`, so the script text crosses the network only when
the server's script cache lacks it. Its errors name the command and the cause, never the token.

## Contract suite

`describeQueueStoreContract` (`src/queue-store-contract.ts`, test-only, not exported) is the
`QueueStore` contract (ADR 0010, AT-42): positions, pre-queue ahead of later joins, FIFO later
joins, `ZADD NX` re-joins, leave, prefix isolation and a race of concurrent joins on separate
connections. `redis-queue-store.test.ts` runs it against real Redis and
`upstash-queue-store.test.ts` against an Upstash-compatible endpoint: the `redis-http` service in
`docker-compose.yml` (serverless-redis-http in front of the same Redis), which `pnpm infra:up` and
CI start. Adapter-specific tests cover the stored key layout and scores, and for Upstash the
`NOSCRIPT` fallback and token-free errors.

## Invariants

- **Fair pre-queue:** a join before `onSaleAt` scores `Random.next()` in `[0, 1)`; a later join
  scores `1 + sequence` (at least 2). Every pre-queue buyer is therefore ahead of every later
  buyer, in random order (equivalent to shuffling the pre-queue at `onSaleAt`); later buyers are
  FIFO (AT-36).
- **Refresh keeps the position:** `ZADD NX` never overwrites a score, and a re-join draws no new
  sequence number (AT-37). A second tab of the same session is the same member.
- **One member per session:** the member is `principal.sessionId`, the future admission token's
  `sub`. A guest who clears cookies is a new session and joins at the back.
- **Redis decides only order:** losing the queue degrades fairness, never seat correctness
  (seat state lives in Postgres, ADR 0005).

## API and wiring

`queue.join`, `queue.status` and `queue.leave` take `{ eventId }` (zod `uuid`; a malformed id is
`BAD_REQUEST` naming `eventId`). `join` reads the event schedule from Postgres (`NOT_FOUND` for an
unknown event) and hands it to the policy. The service is built per request from the context:
`ctx.now`, `ctx.random` (`Math.random` at the app boundary) and `ctx.queueStore()`.

`ctx.queueStore()` (`createLazyQueueStore`) validates `REDIS_URL` (`redis://` or `rediss://`,
`parseQueueEnv`) on first call, connects one node-redis client per process and reuses it. A bad
value fails only the queue procedures, naming the variable, is logged once and is not re-read; a
failed connection is retried on the next call. Context creation never reads `REDIS_URL`.
