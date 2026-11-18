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
  };
}

// The ZSCORE guard draws a sequence number only for a new member, so re-joins leave no gaps;
// ZADD NX is what guarantees an existing score is never overwritten. INCR, ZADD and ZRANK run in
// one script, so concurrent joins get distinct, increasing scores and an exact position.
// KEYS: queue, sequence. ARGV: member, pre-queue score ('' for a later join). Returns the rank.
export const JOIN_SCRIPT = `
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
// KEYS: queue, active, admission, admitted. ARGV: member.
// Returns 1 when the member was queued or held a slot.
export const LEAVE_SCRIPT = `
local queued = redis.call('ZREM', KEYS[1], ARGV[1])
local held = redis.call('ZREM', KEYS[2], ARGV[1])
local jti = redis.call('HGET', KEYS[3], ARGV[1])
if jti then
  redis.call('HDEL', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[4], jti)
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
// KEYS: queue, active, bucket, admission, admitted.
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
    end
    redis.call('ZADD', KEYS[2], now, member)
    redis.call('HSET', KEYS[4], member, jti)
    redis.call('ZADD', KEYS[5], now + ttl, jti)
    result[#result + 1] = member
    result[#result + 1] = jti
  end
  tokens = tokens - #popped / 2
end
redis.call('HSET', KEYS[3], 'tokens', tostring(tokens), 'ts', tostring(now))
return result
`;

// XX after the ZSCORE guard: a heartbeat never creates a slot, only refreshes one.
// KEYS: active. ARGV: member, now ms. Returns 1 when the member holds a slot.
export const HEARTBEAT_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], 'XX', ARGV[2], ARGV[1])
  return 1
end
return 0
`;

// Freeing a slot and revoking its jti are one step, so a freed slot never leaves a valid
// admission behind (ADR 0008). KEYS: active, admission, admitted. ARGV: member.
// Returns 1 when the member held a slot.
export const RELEASE_SLOT_SCRIPT = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
local jti = redis.call('HGET', KEYS[2], ARGV[1])
if jti then
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], jti)
end
return removed
`;

// Walks the active set, which maxActive bounds, so the script stays short. A slot is freed when
// it is idle or its admission is missing or expired; expired jtis without a slot are dropped too.
// KEYS: active, admission, admitted. ARGV: now ms, idle cutoff ms. Returns the freed members.
export const REAP_SCRIPT = `
local now = tonumber(ARGV[1])
local idle_before = tonumber(ARGV[2])
local slots = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local freed = {}
for i = 1, #slots, 2 do
  local member = slots[i]
  local jti = redis.call('HGET', KEYS[2], member)
  local expires = jti and redis.call('ZSCORE', KEYS[3], jti)
  if tonumber(slots[i + 1]) < idle_before or not expires or tonumber(expires) <= now then
    redis.call('ZREM', KEYS[1], member)
    if jti then
      redis.call('HDEL', KEYS[2], member)
      redis.call('ZREM', KEYS[3], jti)
    end
    freed[#freed + 1] = member
  end
end
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now)
return freed
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

/** Every script by name, so an adapter can cache per-script data (the Upstash SHA-1s). */
export const QUEUE_SCRIPTS = {
  join: JOIN_SCRIPT,
  leave: LEAVE_SCRIPT,
  admit: ADMIT_SCRIPT,
  heartbeat: HEARTBEAT_SCRIPT,
  releaseSlot: RELEASE_SLOT_SCRIPT,
  reap: REAP_SCRIPT,
  isAdmitted: IS_ADMITTED_SCRIPT,
  counts: COUNTS_SCRIPT,
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
    return [keys.active, keys.admission, keys.admitted];
  };

  return {
    async join(eventId, member, score) {
      const keys = keysOf(eventId);
      const rank = await run(
        "join",
        [keys.queue, keys.sequence],
        [member, joinScoreArgument(score)],
      );
      return toInteger(rank, "join") + 1;
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
        [keys.queue, keys.active, keys.bucket, keys.admission, keys.admitted],
        admitArguments(request),
      );
      return toAdmissions(reply);
    },

    async heartbeat(eventId, member, now) {
      const reply = await run(
        "heartbeat",
        [keysOf(eventId).active],
        [member, String(now.getTime())],
      );
      return toInteger(reply, "heartbeat") === 1;
    },

    async releaseSlot(eventId, member) {
      return toInteger(await run("releaseSlot", slotKeys(eventId), [member]), "releaseSlot") === 1;
    },

    async reap(eventId, cutoffs) {
      const reply = await run("reap", slotKeys(eventId), [
        String(cutoffs.now.getTime()),
        String(cutoffs.idleBefore.getTime()),
      ]);
      return toStrings(reply, "reap");
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

export function toCounts(reply: unknown): { queued: number; active: number } {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error(`waiting-room counts script returned ${String(reply)}, expected two integers`);
  }
  return { queued: toInteger(reply[0], "counts"), active: toInteger(reply[1], "counts") };
}
