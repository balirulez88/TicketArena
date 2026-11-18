import type { QueueStore } from "./ports";
import {
  JOIN_SCRIPT,
  joinScoreArgument,
  LEAVE_SCRIPT,
  queueKeys,
  toInteger,
} from "./queue-scripts";

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

/** `QueueStore` over node-redis; key layout and scripts live in `queue-scripts.ts`. */
export function createRedisQueueStore(
  client: RedisQueueClient,
  options: RedisQueueStoreOptions,
): QueueStore {
  return {
    async join(eventId, member, score) {
      const keys = queueKeys(options.prefix, eventId);
      const rank = await client.eval(JOIN_SCRIPT, {
        keys: [keys.queue, keys.sequence],
        arguments: [member, joinScoreArgument(score)],
      });
      return toInteger(rank, "join") + 1;
    },

    async position(eventId, member) {
      const rank = await client.zRank(queueKeys(options.prefix, eventId).queue, member);
      return rank === null ? null : rank + 1;
    },

    async leave(eventId, member) {
      const removed = await client.eval(LEAVE_SCRIPT, {
        keys: [queueKeys(options.prefix, eventId).queue],
        arguments: [member],
      });
      return toInteger(removed, "leave") === 1;
    },
  };
}
