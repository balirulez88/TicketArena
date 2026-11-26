import type { AdmitRequest, JoinScore, QueueStore } from "./ports";

// Shared by every `QueueStore` adapter, so the node-redis and Upstash adapters run the same Lua
// against the same key layout (the contract suite proves they behave the same).

/**
 * Keys per event; the `{eventId}` hash tag keeps them in one cluster slot, which multi-key
 * scripts require.
 * - `queue`: ZSET, member = session id, score = join score.
 * - `seq`: counter behind the `1 + sequence` scores.
 * - `active`: ZSET of admitted sessions holding a slot, score = `lastSeenAt` (epoch ms).
 * - `bucket`: HASH `tokens`, `ts` (epoch ms of the last refill): the admission token bucket.
 * - `admission`: HASH session id → its admission `jti`.
 * - `admitted`: ZSET member = `jti`, score = admission expiry (epoch ms): the admitted set.
 * - `holders`: HASH `jti` → session id, the reverse of `admission`, so the reaper can go from an
 *   expired `jti` (found by its `admitted` score) to the slot it must free. Every script that
 *   writes or removes an `admission` entry writes or removes the `holders` entry in the same step.
 */
export function queueKeys(prefix: string, eventId: string) {
  const base = `${prefix}waiting-room:{${eventId}}`;
  return {
    queue: `${base}:queue`,
    sequence: `${base}:seq`,
    active: `${base}:active`,
    bucket: `${base}:bucket`,
    admission: `${base}:admission`,
    admitted: `${base}:admitted`,
    holders: `${base}:holders`,
  };
}

// A member holding a slot with a valid admission is left alone: queuing it again would let the
// ticker re-admit it and replace the jti the buyer is using. A slot whose admission expired (the
// reaper has not run yet) is freed and its jti revoked, so the member queues at the back like any
// freed session. The expiry check, the removal and the queue write share one script: a tick cannot
// admit the member between them and leave it both admitted and queued, and a delayed join cannot
// free a slot the ticker granted after that join read the old one (the PR #12 review race).
// The ZSCORE guard draws a sequence number only for a new member, so re-joins leave no gaps;
// ZADD NX is what guarantees an existing score is never overwritten. INCR, ZADD and ZRANK run in
// one script, so concurrent joins get distinct, increasing scores and an exact position.
// KEYS: queue, sequence, active, admission, admitted, holders.
// ARGV: member, pre-queue score ('' for a later join), now ms.
// Returns the rank, or -1 when the member holds a slot with a valid admission.
export const JOIN_SCRIPT = `
if redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  local jti = redis.call('HGET', KEYS[4], ARGV[1])
  local expires = jti and redis.call('ZSCORE', KEYS[5], jti)
  if expires and tonumber(expires) > tonumber(ARGV[3]) then
    return -1
  end
  redis.call('ZREM', KEYS[3], ARGV[1])
  if jti then
    redis.call('HDEL', KEYS[4], ARGV[1])
    redis.call('ZREM', KEYS[5], jti)
    redis.call('HDEL', KEYS[6], jti)
  end
end
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local score = ARGV[2]
  if score == '' then
    score = 1 + redis.call('INCR', KEYS[2])
  end
  redis.call('ZADD', KEYS[1], 'NX', score, ARGV[1])
end
return redis.call('ZRANK', KEYS[1], ARGV[1])
`;

// Leaving the queue, freeing the slot and revoking the jti are one step. As separate commands
// (over Upstash REST, separate HTTP requests in no fixed order) the ticker could pop the member
// between them and leave it admitted after it left.
// KEYS: queue, active, admission, admitted, holders. ARGV: member.
// Returns 1 when the member was queued or held a slot.
export const LEAVE_SCRIPT = `
local queued = redis.call('ZREM', KEYS[1], ARGV[1])
local held = redis.call('ZREM', KEYS[2], ARGV[1])
local jti = redis.call('HGET', KEYS[3], ARGV[1])
if jti then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[4], jti)
  redis.call('HDEL', KEYS[5], jti)
end
if queued + held > 0 then
  return 1
end
return 0
`;

// Refill, the maxActive check, the pop from the head and the slot writes are one script, so
// concurrent tickers (several workers, or a slow tick overlapping the next) share one bucket and
// can never admit past either limit. Time is the caller's injected clock, not Redis TIME, and a
// clock that steps back refills nothing. An empty queue spends no tokens. Re-admitting a member
// that still holds a slot replaces its jti, so it never keeps two valid admissions.
// KEYS: queue, active, bucket, admission, admitted, holders.
// ARGV: now ms, admitRate, maxActive, admission ttl ms, jti... Returns member, jti, member, jti...
export const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local max_active = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local tokens = rate
local state = redis.call('HMGET', KEYS[3], 'tokens', 'ts')
if state[1] then
  local elapsed = math.max(0, now - tonumber(state[2]))
  tokens = math.min(rate, tonumber(state[1]) + elapsed * rate / 1000)
end
local count = math.min(math.floor(tokens), max_active - redis.call('ZCARD', KEYS[2]), #ARGV - 4)
local result = {}
if count > 0 then
  local popped = redis.call('ZPOPMIN', KEYS[1], count)
  for i = 1, #popped, 2 do
    local member = popped[i]
    local jti = ARGV[4 + (i + 1) / 2]
    local previous = redis.call('HGET', KEYS[4], member)
    if previous then
      redis.call('ZREM', KEYS[5], previous)
      redis.call('HDEL', KEYS[6], previous)
    end
    redis.call('ZADD', KEYS[2], now, member)
    redis.call('HSET', KEYS[4], member, jti)
    redis.call('ZADD', KEYS[5], now + ttl, jti)
    redis.call('HSET', KEYS[6], jti, member)
    result[#result + 1] = member
    result[#result + 1] = jti
  end
  tokens = tokens - #popped / 2
end
redis.call('HSET', KEYS[3], 'tokens', tostring(tokens), 'ts', tostring(now))
return result
`;

// A heartbeat keeps a slot alive only while its admission is valid. An expired admission is
// unusable (the admission script reads it as none), so polling must not hold its slot open: it
// goes idle and the reaper frees it within the idle timeout. That also bounds a slot the reaper
// cannot reach from its expired jti, one admitted before the `holders` index existed (PR #18).
// XX after the ZSCORE guard: a heartbeat never creates a slot, only refreshes one.
// KEYS: active, admission, admitted. ARGV: member, now ms.
// Returns 1 when the member holds a slot with a valid admission.
export const HEARTBEAT_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return 0
end
local jti = redis.call('HGET', KEYS[2], ARGV[1])
local expires = jti and redis.call('ZSCORE', KEYS[3], jti)
if not expires or tonumber(expires) <= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
return 1
`;

// Freeing a slot and revoking its jti are one step, so a freed slot never leaves a valid
// admission behind (ADR 0008). KEYS: active, admission, admitted, holders. ARGV: member.
// Returns 1 when the member held a slot.
export const RELEASE_SLOT_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
local jti = redis.call('HGET', KEYS[2], ARGV[1])
if jti then
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], jti)
  redis.call('HDEL', KEYS[4], jti)
end
return removed
`;

// One bounded step of a reaper pass (ticket 69). Once the queue closes, immediate admission
// bypasses maxActive, so the active set is bounded only by the buyers seen in the last idle
// timeout (90 s); walking all of it in one script would block the event's other queue operations
// for as long as it ran. Instead the candidates come from the two sorted indexes: slots by
// lastSeenAt below the idle cutoff (exclusive), then jtis by expiry at or before now, together at
// most ARGV[3]. A slot is freed with its jti revoked in the same step (ADR 0008); an expired jti
// whose holder holds no slot under it is only dropped. The two LIMIT 1 probes tell the caller
// whether another call has work, without counting the rest.
// KEYS: active, admission, admitted, holders. ARGV: now ms, idle cutoff ms, batch size.
// Returns { 1 when candidates remain else 0, { freed member... } }.
export const REAP_SCRIPT = `
local idle_below = '(' .. ARGV[2]
local batch = tonumber(ARGV[3])
local freed = {}
local function free(member, jti)
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[2], member)
  if jti then
    redis.call('ZREM', KEYS[3], jti)
    redis.call('HDEL', KEYS[4], jti)
  end
  freed[#freed + 1] = member
end
local idle = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', idle_below, 'LIMIT', 0, batch)
for _, member in ipairs(idle) do
  free(member, redis.call('HGET', KEYS[2], member))
end
local remaining = batch - #idle
if remaining > 0 then
  local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, remaining)
  for _, jti in ipairs(expired) do
    local member = redis.call('HGET', KEYS[4], jti)
    if member and redis.call('HGET', KEYS[2], member) == jti then
      free(member, jti)
    else
      redis.call('ZREM', KEYS[3], jti)
      redis.call('HDEL', KEYS[4], jti)
    end
  end
end
local more = 0
if #redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', idle_below, 'LIMIT', 0, 1) > 0
  or #redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 1) > 0 then
  more = 1
end
return { more, freed }
`;

// After the queue closes admission is immediate (ADR 0008), so the bucket and maxActive do not
// apply. A member whose admission is still valid keeps it: a new jti would revoke the token it is
// using. A slot whose admission expired (the reaper has not run yet) is replaced in the same step,
// so the buyer is not stuck until the next reap. The queue entry goes too, so a ticker never
// admits the member a second time.
// KEYS: queue, active, admission, admitted, holders. ARGV: member, now ms, ttl ms, jti.
// Returns 1 when a slot was created or replaced, 0 when the member kept a valid one.
export const ADMIT_IMMEDIATELY_SCRIPT = `
local now = tonumber(ARGV[2])
if redis.call('ZSCORE', KEYS[2], ARGV[1]) then
  local old = redis.call('HGET', KEYS[3], ARGV[1])
  local expires = old and redis.call('ZSCORE', KEYS[4], old)
  if expires and tonumber(expires) > now then
    return 0
  end
  if old then
    redis.call('ZREM', KEYS[4], old)
    redis.call('HDEL', KEYS[5], old)
  end
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], now, ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
redis.call('ZADD', KEYS[4], now + tonumber(ARGV[3]), ARGV[4])
redis.call('HSET', KEYS[5], ARGV[4], ARGV[1])
return 1
`;

// Read-only: the slot, its jti and the jti's expiry from one snapshot, so a slot freed in
// between is never reported with a half-removed admission. An expired admission reads as none
// even before the reaper frees its slot, so it is never reported, or minted into a token, as usable.
// KEYS: active, admission, admitted. ARGV: member, now ms. Returns { jti, expiry ms } or {}.
export const ADMISSION_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  return {}
end
local jti = redis.call('HGET', KEYS[2], ARGV[1])
local expires = jti and redis.call('ZSCORE', KEYS[3], jti)
if not expires or tonumber(expires) <= tonumber(ARGV[2]) then
  return {}
end
return { jti, expires }
`;

// KEYS: admitted. ARGV: jti, now ms. Returns 1 while the jti is admitted and unexpired.
export const IS_ADMITTED_SCRIPT = `
local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
if expires and tonumber(expires) > tonumber(ARGV[2]) then
  return 1
end
return 0
`;

// KEYS: queue, active. Returns { queue length, active count } from one consistent snapshot.
export const COUNTS_SCRIPT = `
return { redis.call('ZCARD', KEYS[1]), redis.call('ZCARD', KEYS[2]) }
`;

// KEYS: every key of one event. One script so no admission tick sees a half-cleared event.
export const CLEAR_EVENT_SCRIPT = `
return redis.call('DEL', unpack(KEYS))
`;

/** Every script by name, so an adapter can cache per-script data (the Upstash SHA-1s). */
export const QUEUE_SCRIPTS = {
  join: JOIN_SCRIPT,
  leave: LEAVE_SCRIPT,
  admit: ADMIT_SCRIPT,
  heartbeat: HEARTBEAT_SCRIPT,
  releaseSlot: RELEASE_SLOT_SCRIPT,
  reap: REAP_SCRIPT,
  admitImmediately: ADMIT_IMMEDIATELY_SCRIPT,
  admission: ADMISSION_SCRIPT,
  isAdmitted: IS_ADMITTED_SCRIPT,
  counts: COUNTS_SCRIPT,
  clearEvent: CLEAR_EVENT_SCRIPT,
} as const;

export type QueueScriptName = keyof typeof QUEUE_SCRIPTS;

/** How an adapter runs one script: EVAL over node-redis, EVALSHA/EVAL over Upstash REST. */
export type ScriptRunner = (
  name: QueueScriptName,
  keys: readonly string[],
  args: readonly string[],
) => Promise<unknown>;

/**
 * The `QueueStore` both adapters expose: every method but `position` (a plain `ZRANK`) is one
 * script run through the adapter's runner, so the adapters differ only in transport.
 */
export function createScriptedQueueStore(
  prefix: string,
  run: ScriptRunner,
  position: QueueStore["position"],
): QueueStore {
  const keysOf = (eventId: string) => queueKeys(prefix, eventId);
  const slotKeys = (eventId: string) => {
    const keys = keysOf(eventId);
    return [keys.active, keys.admission, keys.admitted, keys.holders];
  };

  return {
    async join(eventId, member, score, now) {
      const keys = keysOf(eventId);
      const rank = toInteger(
        await run(
          "join",
          [keys.queue, keys.sequence, ...slotKeys(eventId)],
          [member, joinScoreArgument(score), String(now.getTime())],
        ),
        "join",
      );
      return rank < 0 ? { status: "ADMITTED" } : { status: "QUEUED", position: rank + 1 };
    },

    position,

    async leave(eventId, member) {
      const keys = keysOf(eventId);
      const reply = await run("leave", [keys.queue, ...slotKeys(eventId)], [member]);
      return toInteger(reply, "leave") === 1;
    },

    async admit(eventId, request) {
      const keys = keysOf(eventId);
      const reply = await run(
        "admit",
        [keys.queue, keys.active, keys.bucket, keys.admission, keys.admitted, keys.holders],
        admitArguments(request),
      );
      return toAdmissions(reply);
    },

    async heartbeat(eventId, member, now) {
      const keys = keysOf(eventId);
      const reply = await run(
        "heartbeat",
        [keys.active, keys.admission, keys.admitted],
        [member, String(now.getTime())],
      );
      return toInteger(reply, "heartbeat") === 1;
    },

    async releaseSlot(eventId, member) {
      return toInteger(await run("releaseSlot", slotKeys(eventId), [member]), "releaseSlot") === 1;
    },

    async reap(eventId, request) {
      const reply = await run("reap", slotKeys(eventId), [
        String(request.now.getTime()),
        String(request.idleBefore.getTime()),
        String(request.batchSize),
      ]);
      return toReapBatch(reply);
    },

    async admitImmediately(eventId, member, grant) {
      const keys = keysOf(eventId);
      const reply = await run(
        "admitImmediately",
        [keys.queue, ...slotKeys(eventId)],
        [member, String(grant.now.getTime()), String(grant.admissionTtlMs), grant.jti],
      );
      return toInteger(reply, "admitImmediately") === 1;
    },

    async admission(eventId, member, now) {
      const keys = keysOf(eventId);
      const reply = toStrings(
        await run(
          "admission",
          [keys.active, keys.admission, keys.admitted],
          [member, String(now.getTime())],
        ),
        "admission",
      );
      const [jti, expiresAt] = reply;
      return jti === undefined || expiresAt === undefined
        ? null
        : { jti, expiresAt: new Date(Number(expiresAt)) };
    },

    async isAdmitted(eventId, jti, now) {
      const reply = await run(
        "isAdmitted",
        [keysOf(eventId).admitted],
        [jti, String(now.getTime())],
      );
      return toInteger(reply, "isAdmitted") === 1;
    },

    async counts(eventId) {
      const keys = keysOf(eventId);
      return toCounts(await run("counts", [keys.queue, keys.active], []));
    },

    async clearEvent(eventId) {
      toInteger(await run("clearEvent", Object.values(keysOf(eventId)), []), "clearEvent");
    },
  };
}

export function joinScoreArgument(score: JoinScore): string {
  return score.kind === "PRE_QUEUE" ? String(score.score) : "";
}

export function admitArguments(request: AdmitRequest): string[] {
  return [
    String(request.now.getTime()),
    String(request.admitRate),
    String(request.maxActive),
    String(request.admissionTtlMs),
    ...request.jtis,
  ];
}

export function toInteger(reply: unknown, script: string): number {
  if (typeof reply !== "number" || !Number.isInteger(reply)) {
    throw new Error(`waiting-room ${script} script returned ${String(reply)}, expected an integer`);
  }
  return reply;
}

export function toStrings(reply: unknown, script: string): string[] {
  if (!(Array.isArray(reply) && reply.every((item) => typeof item === "string"))) {
    throw new Error(`waiting-room ${script} script returned ${String(reply)}, expected strings`);
  }
  return reply;
}

export function toAdmissions(reply: unknown): { sessionId: string; jti: string }[] {
  const flat = toStrings(reply, "admit");
  const admissions: { sessionId: string; jti: string }[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    admissions.push({ sessionId: flat[index] ?? "", jti: flat[index + 1] ?? "" });
  }
  return admissions;
}

export function toReapBatch(reply: unknown): { freed: string[]; more: boolean } {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error(`waiting-room reap script returned ${String(reply)}, expected [more, freed]`);
  }
  return { more: toInteger(reply[0], "reap") === 1, freed: toStrings(reply[1], "reap") };
}

export function toCounts(reply: unknown): { queued: number; active: number } {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error(`waiting-room counts script returned ${String(reply)}, expected two integers`);
  }
  return { queued: toInteger(reply[0], "counts"), active: toInteger(reply[1], "counts") };
}
