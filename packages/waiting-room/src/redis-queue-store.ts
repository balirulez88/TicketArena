import type { QueueStore } from "./ports";
import { createScriptedQueueStore, QUEUE_SCRIPTS, queueKeys } from "./queue-scripts";

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
  return createScriptedQueueStore(
    options.prefix,
    (name, keys, args) =>
      client.eval(QUEUE_SCRIPTS[name], { keys: [...keys], arguments: [...args] }),
    async (eventId, member) => {
      const rank = await client.zRank(queueKeys(options.prefix, eventId).queue, member);
      return rank === null ? null : rank + 1;
    },
  );
}
