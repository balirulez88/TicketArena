import type { Logger } from "@ticketarena/contracts";
import { createRedisQueueStore, type QueueStore } from "@ticketarena/waiting-room";
import { parseQueueEnv } from "./env";
import { createBoundedRedis } from "./redis-client";

interface LazyQueueStoreConfig {
  readonly readEnv: () => Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  /** Key prefix for every waiting-room key, so environments can share one Redis. */
  readonly prefix: string;
}

/**
 * Builds the queue store on first call: validates `REDIS_URL` and the Redis timeouts and returns
 * one store per process over a lazily connected, bounded node-redis client (`createBoundedRedis`).
 * An invalid configuration is logged once and rethrown on every later call without re-reading the
 * environment. Redis itself is first contacted by the first store call, so an outage fails that
 * call (`RedisUnavailableError`) within the timeouts, and the next call connects anew.
 */
export function createLazyQueueStore({
  readEnv,
  logger,
  prefix,
}: LazyQueueStoreConfig): () => Promise<QueueStore> {
  let configFailure: Error | undefined;
  let store: QueueStore | undefined;

  return async () => {
    if (configFailure !== undefined) {
      throw configFailure;
    }
    if (store === undefined) {
      let env: ReturnType<typeof parseQueueEnv>;
      try {
        env = parseQueueEnv(readEnv());
      } catch (error) {
        configFailure = error instanceof Error ? error : new Error(String(error));
        logger.error({ err: configFailure.message }, "queue configuration is invalid");
        throw configFailure;
      }
      const redis = createBoundedRedis({
        url: env.REDIS_URL,
        timeouts: {
          connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
          commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
        },
        logger,
      });
      store = createRedisQueueStore(
        {
          eval: (script, options) => redis.run((client) => client.eval(script, options)),
          zRank: (key, member) => redis.run((client) => client.zRank(key, member)),
        },
        { prefix },
      );
    }
    return store;
  };
}
