import type { QueueStore } from "./ports";

/**
 * The node-redis commands the adapter needs. A connected `createClient()` from `redis` satisfies
 * it; keeping it narrow keeps the package free of a runtime client dependency.
 */
export interface RedisQueueClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  zRank(key: string, member: string): Promise<number | null>;
}

export interface RedisQueueStoreOptions {
  /** Prepended to every key, so environments and test files can share one Redis. */
  readonly prefix: string;
}

// The ZSCORE guard draws a sequence number only for a new member, so re-joins leave no gaps;
// ZADD NX is what guarantees an existing score is never overwritten. INCR, ZADD and ZRANK run in
// one script, so concurrent joins get distinct, increasing scores and an exact position.
const JOIN_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local score = ARGV[2]
  if score == '' then
    score = 1 + redis.call('INCR', KEYS[2])
  end
  redis.call('ZADD', KEYS[1], 'NX', score, ARGV[1])
end
return redis.call('ZRANK', KEYS[1], ARGV[1])
`;

const LEAVE_SCRIPT = "return redis.call('ZREM', KEYS[1], ARGV[1])";

/**
 * `QueueStore` over node-redis. Keys per event (the `{eventId}` hash tag keeps them in one
 * cluster slot, which multi-key scripts require):
 * - `<prefix>waiting-room:{<eventId>}:queue`: ZSET, member = session id, score = join score.
 * - `<prefix>waiting-room:{<eventId>}:seq`: counter behind the `1 + sequence` scores.
 */
export function createRedisQueueStore(
  client: RedisQueueClient,
  options: RedisQueueStoreOptions,
): QueueStore {
  const queueKey = (eventId: string) => `${options.prefix}waiting-room:{${eventId}}:queue`;
  const sequenceKey = (eventId: string) => `${options.prefix}waiting-room:{${eventId}}:seq`;

  return {
    async join(eventId, member, score) {
      const rank = await client.eval(JOIN_SCRIPT, {
        keys: [queueKey(eventId), sequenceKey(eventId)],
        arguments: [member, score.kind === "PRE_QUEUE" ? String(score.score) : ""],
      });
      return toInteger(rank, "join") + 1;
    },

    async position(eventId, member) {
      const rank = await client.zRank(queueKey(eventId), member);
      return rank === null ? null : rank + 1;
    },

    async leave(eventId, member) {
      const removed = await client.eval(LEAVE_SCRIPT, {
        keys: [queueKey(eventId)],
        arguments: [member],
      });
      return toInteger(removed, "leave") === 1;
    },
  };
}

function toInteger(reply: unknown, script: string): number {
  if (typeof reply !== "number" || !Number.isInteger(reply)) {
    throw new Error(`waiting-room ${script} script returned ${String(reply)}, expected an integer`);
  }
  return reply;
}
