import type { Logger } from "@ticketarena/contracts";
import { createRedisQueueStore, type QueueStore } from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { parseQueueEnv } from "./env";

interface LazyQueueStoreConfig {
  readonly readEnv: () => Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
  /** Key prefix for every waiting-room key, so environments can share one Redis. */
  readonly prefix: string;
}

/**
 * Builds the queue store on first call: validates `REDIS_URL`, connects one node-redis client per
 * process and reuses it. An invalid configuration is logged once and rethrown on every later
 * call without re-reading the environment; a failed connection is forgotten so the next call
 * retries it.
 */
export function createLazyQueueStore({
  readEnv,
  logger,
  prefix,
}: LazyQueueStoreConfig): () => Promise<QueueStore> {
  let configFailure: Error | undefined;
  let pending: Promise<QueueStore> | undefined;

  const connect = async (url: string): Promise<QueueStore> => {
    const client = createClient({ url });
    // Without a listener node-redis rethrows socket errors as uncaught exceptions.
    client.on("error", (error: unknown) => {
      logger.error({ err: error instanceof Error ? error.message : String(error) }, "queue redis");
    });
    await client.connect();
    return createRedisQueueStore(client, { prefix });
  };

  return () => {
    if (configFailure !== undefined) {
      return Promise.reject(configFailure);
    }
    if (pending === undefined) {
      let url: string;
      try {
        url = parseQueueEnv(readEnv()).REDIS_URL;
      } catch (error) {
        configFailure = error instanceof Error ? error : new Error(String(error));
        logger.error({ err: configFailure.message }, "queue configuration is invalid");
        return Promise.reject(configFailure);
      }
      pending = connect(url).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}
