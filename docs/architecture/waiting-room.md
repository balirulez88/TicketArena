# Waiting room

[← Architecture](index.md)

Decisions: [ADR 0002](../adr/0002-redis-waiting-room.md), [ADR 0008](../adr/0008-waiting-room-admission.md).
Code: `packages/waiting-room` (module), `apps/web/src/server/routers/queue.ts` (API),
`apps/web/src/server/queue-store.ts` (wiring), `apps/web/src/server/admission-token.ts` and
`admittedProcedure` in `apps/web/src/server/trpc.ts` (admission token),
`apps/worker/src/admission.ts` (ticker and reaper).

Built so far: join, status and leave, with fair ordering; admission from the queue head by a
worker ticker (token bucket plus `maxActive`), active slots with heartbeats, and slot freeing on
leave, order placed and reaping, which revokes the admission `jti`; immediate admission once the
queue has closed; the signed admission token (JWT cookie) minted on the admitted session's
status poll; and `booking.holdSeats` gated by it (`admittedProcedure`); all on two
interchangeable `QueueStore` adapters (node-redis and Upstash REST).

## Module surface

| Export                                     | Role                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueueService`                             | `join`, `status`, `leave`, `heartbeat`, `admitTick(event, limits)`, `reap`, `releaseSlot`, `isAdmitted(eventId, jti)`, `counts`                           |
| `QueueStore` (port)                        | `join`, `position` (1-based), `leave`, `admit`, `admitImmediately`, `admission`, `heartbeat`, `releaseSlot`, `reap`, `isAdmitted`, `counts`, `clearEvent` |
| `AdmissionLimits`                          | `{ admitRate, maxActive }` per tick; the worker supplies them from its configuration                                                                      |
| `SLOT_IDLE_TIMEOUT_MS`, `ADMISSION_TTL_MS` | 90 s idle before reaping; 30 min admission validity from admission (fixed)                                                                                |
| `createRedisQueueStore`                    | node-redis adapter over the narrow `RedisQueueClient` (`eval`, `zRank`); options: `prefix`                                                                |
| `createUpstashQueueStore`                  | Upstash REST adapter (`fetch`); options: `url`, `token`, `prefix`, `timeoutMs` (default 2000)                                                             |
| `AdmissionPolicy` (port)                   | `phase(event, now)`: a `QueuePhase`, `NOT_OPEN`, `ACTIVE` or `CLOSED`                                                                                     |
| `createScheduleAdmissionPolicy`            | MVP policy: `NOT_OPEN` before `queueOpensAt`, `ACTIVE` from it (inclusive) to `queueClosesAt` (exclusive), `CLOSED` from then on                          |
| `Clock`, `Random`, `newId`                 | Injected; the module never reads the system clock, `Math.random` or a UUID source. `Random.next()` returns `[0, 1)`; `newId` makes admission `jti`s       |

`QueueStore.join` returns a `JoinOutcome`: `{ status: "QUEUED", position }` or
`{ status: "ADMITTED" }` when the member holds a slot.

`QueueService.join` results: before `queueOpensAt` `{ status: "NOT_OPEN", queueOpensAt }` (nothing is queued
and no one is admitted; the page can say when to come back); from `queueClosesAt` on
`{ status: "ADMISSIBLE" }` (admitted at once: the session gets a slot and a `jti` outside the
queue, the token bucket and `maxActive`, or keeps the slot and `jti` it already holds; nothing is
queued); in the window
`[queueOpensAt, queueClosesAt)` `{ status: "QUEUED", position, etaSeconds }`, or
`{ status: "ADMITTED" }` when the session already holds a slot (nothing is queued; its slot and
`jti` are unchanged). The phase is checked first, so before the window `NOT_OPEN` is answered
without looking at slots. `status` heartbeats the session's slot and returns
`{ status: "ADMITTED", admission: { jti, expiresAt } }` when it holds one (the web app signs it
into the admission token and returns only `{ status: "ADMITTED" }`), else `QUEUED` with position
and ETA, or `NOT_QUEUED`. `leave` leaves the queue and frees the slot in one atomic step; `{ left }` is true if
either happened. `admitTick` admits no one before the event's `onSaleAt`. ETA = `ceil(position / admitRatePerSecond)`; the web app assumes 10 admissions
per second (the worker's default `ADMIT_RATE_PER_SECOND`) and does not read the worker's setting.
`counts(eventId)` returns `{ queued, active }` (queue length and active shoppers); `admin.snapshot`
reads it for every event.

## Redis keys

All keys start with the store's configurable `prefix` (the web app uses none; each test file uses
its own). `{eventId}` is a hash tag so an event's keys share one cluster slot, which multi-key
scripts need.

| Key                                          | Type    | Content                                                            |
| -------------------------------------------- | ------- | ------------------------------------------------------------------ |
| `<prefix>waiting-room:{<eventId>}:queue`     | ZSET    | member = session id, score = join score (see below)                |
| `<prefix>waiting-room:{<eventId>}:seq`       | counter | source of the `1 + sequence` scores of later joins                 |
| `<prefix>waiting-room:{<eventId>}:active`    | ZSET    | active slots: member = session id, score = `lastSeenAt` (epoch ms) |
| `<prefix>waiting-room:{<eventId>}:bucket`    | HASH    | token bucket: `tokens` (fractional), `ts` = last refill (epoch ms) |
| `<prefix>waiting-room:{<eventId>}:admission` | HASH    | session id → its admission `jti`                                   |
| `<prefix>waiting-room:{<eventId>}:admitted`  | ZSET    | admitted set: member = `jti`, score = expiry (epoch ms)            |

## Scripts

Every mutation is one Lua script, so it is atomic against concurrent calls on other connections.
Reads are a single `ZRANK` (`position`) or a read-only script (`isAdmitted`, `counts`). Both
adapters share the scripts, the key layout and the method mapping (`createScriptedQueueStore` in
`src/queue-scripts.ts`) and differ only in how a script is sent, so they read and write the same
data. Times come from the injected clock (epoch ms), never Redis `TIME`.

- **join**: if the member holds a slot (`ZSCORE active`) whose admission is still valid at `now`,
  returns `-1` (`ADMITTED`) and writes nothing; a slot whose admission expired before the reaper
  ran is freed and its `jti` revoked (as in **releaseSlot**). Then, if the member has no score, its
  score is the given pre-queue value, or `1 + INCR seq` for a later join; then `ZADD NX`; returns
  the member's rank. The expiry check, the removal and the queue write are one script, so a tick
  cannot admit the member between them, and a delayed join (a refresh and a second tab sent
  together) cannot free a slot the ticker granted after the first of them requeued the member.
- **leave**: `ZREM` from the queue, then frees the slot and revokes its `jti` like
  **releaseSlot**, in one script, so the ticker cannot admit the member between the two; returns
  whether the member was queued or held a slot.
- **admit**: refills the bucket by `elapsed × admitRate / 1000` up to the burst `admitRate` (a
  bucket seen for the first time is full; a clock that steps back refills nothing), then admits
  `min(floor(tokens), maxActive − active, jtis supplied)` members with `ZPOPMIN`: each enters
  `active` at `now` and gets its `jti` in `admission` and in `admitted` with expiry
  `now + 30 min`; one token is spent per admitted member (an empty queue spends none).
  Re-admitting a member that still holds a slot replaces its old `jti`.
- **admitImmediately** (queue closed): if the member holds a slot whose admission is still valid,
  nothing changes (a new `jti` would revoke the token in use); a slot whose admission expired
  before the reaper ran has its old `jti` removed and is replaced; otherwise `ZREM` from the
  queue, then the slot, the `admission`
  entry and the `jti` with expiry `now + 30 min`, like one admission of **admit** but without the
  bucket or `maxActive`.
- **admission** (read-only): the member's `jti` and its expiry, only while it holds a slot and
  the admission has not expired by `now`, so an expired admission is never reported or minted
  into a token while it waits for the reaper; `QueueService.status` uses it for the token.
- **heartbeat**: `ZADD XX` of `now`, only if the member holds a slot.
- **releaseSlot**: removes the slot, the member's `admission` entry and its `jti` from
  `admitted`, in one step.
- **reap**: frees every slot last seen before the idle cutoff or whose `jti` is missing or expired
  (the same three removals as releaseSlot), then drops expired `jti`s; it walks all of `active`.
  While the queue is open `maxActive` bounds that set; after it closes, immediate admission
  bypasses `maxActive`, so it is bounded only by the buyers seen in the last 90 s (bounded,
  batched reaping: ticket 69).
- **clearEvent**: `DEL` of all six keys of the event in one script, as if no one had joined (the
  bucket starts full again); `admin.resetDemo` uses it for the demo event.
- **isAdmitted** / **counts**: the `jti`'s `ZSCORE` against `now`; `ZCARD` of `queue` and
  `active` in one snapshot.

The node-redis adapter sends `EVAL`. The Upstash adapter sends `EVALSHA` (SHA-1 computed
locally) and falls back to `EVAL` on `NOSCRIPT`, so the script text crosses the network only when
the server's script cache lacks it. Its errors name the command and the cause, never the token.

## Contract suite

`describeQueueStoreContract` (`src/queue-store-contract.ts`, test-only, not exported) is the
`QueueStore` contract (ADR 0010, AT-42): positions, pre-queue ahead of later joins, FIFO later
joins, `ZADD NX` re-joins, a re-join by an admitted member (`ADMITTED`, same `jti`, one slot,
also racing a ticker on another connection) and by a member whose slot was freed (back of the
queue), leave, prefix isolation and a race of concurrent joins on separate
connections; admission order and `jti`s, bucket burst and refill, the `maxActive` cap, heartbeat,
slot release and reaping with revocation, admission expiry, and a race of concurrent admit
ticks on separate connections that never exceeds the bucket or `maxActive` (AT-38). `redis-queue-store.test.ts` runs it against real Redis and
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
- **Re-joining keeps a live admission:** `join` by a session that holds a slot (a refresh, a
  second tab, a client retry) answers `ADMITTED` and adds nothing to the queue. Queuing it again
  would let the next tick re-admit it, replacing the `jti` the buyer is using. A session whose
  slot was freed (leave, order placed, reaping) holds none, so it joins at the back like anyone.
- **One member per session:** the member is `principal.sessionId`, the admission token's
  `sub`. A guest who clears cookies is a new session and joins at the back.
- **Admission is bounded (AT-38):** admissions never exceed `admitRate` per second (burst
  `admitRate`) nor `maxActive` active slots, even with several tickers (workers) at once: the
  refill, the cap check and the pop are one script against one bucket.
- **No admission before the on-sale:** the ticker admits no one before the event's `onSaleAt`, so
  the randomized pre-queue is admitted in its random order, not in order of arrival.
- **No admission before the queue opens:** `join` before `queueOpensAt` answers `NOT_OPEN` and
  issues nothing; only after the queue closes does `join` admit immediately (`ADMISSIBLE`). Otherwise a buyer
  arriving just before the queue opens would hold a 30-minute admission still valid at
  `onSaleAt` and skip the pre-queue. As defence in depth, `holdSeats` refuses any hold before the
  event's `onSaleAt` (`NOT_ON_SALE`, see [Database](../database/index.md)).
- **A freed slot revokes its admission (AT-39):** leave, order placed and reaping remove the slot
  and its `jti` in the same script, so no valid `jti` outlives its slot.
- **Holding seats requires a live admission (AT-40):** `holdSeats` is refused (`FORBIDDEN`)
  without a valid token for this session and event whose `jti` is still in the admitted set. A
  freed slot therefore stops its token at once, before the token's `exp`.
- **Checkout never needs admission (AT-41):** `placeOrder` and the other booking procedures are
  authorized by ownership of the hold or order, so an admission that expires mid-checkout breaks
  nothing.
- **Redis decides only order:** losing the queue degrades fairness, never seat correctness
  (seat state lives in Postgres, ADR 0005). It does stop new holds: the admitted-set check fails
  closed.

## API and wiring

`queue.join`, `queue.status` and `queue.leave` take `{ eventId }` (zod `uuid`; a malformed id is
`BAD_REQUEST` naming `eventId`). `join` reads the event schedule from Postgres (`NOT_FOUND` for an
unknown event) and hands it to the policy; `NOT_OPEN` is returned to the client as a result
(with `queueOpensAt`), not as an error, and so is `ADMITTED` for a session that holds a slot. The service is built per request from the context:
`ctx.now`, `ctx.random` (`Math.random` at the app boundary), `randomUUID` for `newId` and
`ctx.queueStore()`. `booking.holdSeats` and `booking.placeOrder` build the same service for the
heartbeat and the slot release.

`ctx.queueStore()` (`createLazyQueueStore`) validates `REDIS_URL` (`redis://` or `rediss://`,
`parseQueueEnv`) on first call, connects one node-redis client per process and reuses it. A bad
value fails only the queue procedures, naming the variable, is logged once and is not re-read; a
failed connection is retried on the next call. Context creation never reads `REDIS_URL`.

## Admission and slots

The worker (`apps/worker/src/admission.ts`) runs two loops over every event in the catalog, with
the queue service built in `main.ts` on the same keys as the web app (no prefix):

- **Admission ticker**, every 1 s: `admitTick(eventId, { admitRate, maxActive })` with the
  worker's `ADMIT_RATE_PER_SECOND` (default 10) and `MAX_ACTIVE` (default 100). The limits are
  worker configuration shared by every event; there are no per-event columns.
- **Reaper**, every 15 s: `reap(eventId)` frees slots idle for over 90 s (`lastSeenAt` before
  `now − 90 s`) or whose admission expired (30 min after admission, fixed).

Each loop runs at start and then its interval after each pass ends; a failed pass is logged and
retried. Heartbeats come from `queue.status` polls and from `booking.holdSeats` (the admitted
call). `booking.placeOrder` frees the buyer's slot for the hold's event after the order has
committed. Both are best-effort in the booking router: a Redis failure is logged and never fails
the hold or the order (seat and order state live in Postgres, ADR 0005); a slot left behind is
reaped once it goes idle or its admission expires.

## Admission token

- **Minting:** on an `ADMITTED` `queue.status` poll the web app signs a JWT (HS256,
  `ADMISSION_SECRET`, `jose`) with `sub = sessionId`, `eid = eventId`, the slot's `jti` and
  `exp = admittedAt + 30 min` (the `jti`'s expiry in the admitted set, in whole seconds), and sets
  it as the cookie `ta_adm_<eventId>`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Expires`
  at `exp`. One cookie per event, so admissions to two events are independent. Every `ADMITTED`
  poll re-issues the same claims (no renewal); a queued or unknown session gets no cookie.
- **Context seam:** `ctx.admissionTokens` (`createAdmissionTokens`) hides the cookie and the
  secret: `issue(claims)` appends the `Set-Cookie` to the tRPC response headers (`resHeaders` of
  the fetch adapter), `read(eventId)` returns the claims only when the signature (algorithm
  pinned to HS256) and `exp` (against `ctx.now`) are valid. `ADMISSION_SECRET` (at least 32
  bytes, `parseServerEnv` / `parseAdmissionEnv`) is read on first use, so a missing secret fails
  only `queue.status` for an admitted session and `holdSeats`, naming the variable.
- **`admittedProcedure`** (`apps/web/src/server/trpc.ts`): input must carry `eventId`; it
  requires `read(eventId)` claims with `sub = principal.sessionId` and `eid = input.eventId`, and
  then `QueueStore.isAdmitted(eventId, jti, now)`; anything else is `FORBIDDEN`. Only
  `booking.holdSeats` uses it. `eventId` is trustworthy because the booking core refuses any seat
  not of that event.
- **Bypass by design:** `admin.runRace` calls `BookingService.holdSeats` in-process for synthetic
  buyers and never passes through `admittedProcedure` (the race exercises the booking core;
  operator-only behind `adminProcedure`).
- **Tests:** router tests keep each session's cookies across `createCaller` requests
  (`apps/web/src/server/testing/browser-cookies.ts`), so they obtain tokens through `queue.join`
  and `queue.status` like a browser.
