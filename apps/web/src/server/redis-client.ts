import type { Logger } from "@ticketarena/contracts";
import { createLazyConnection } from "@ticketarena/waiting-room";
import { createClient, ErrorReply } from "redis";

export interface RedisTimeouts {
  /** Bound on opening a connection, handshake included (ms). */
  readonly connectTimeoutMs: number;
  /** Bound on one command, from the call until its reply (ms). */
  readonly commandTimeoutMs: number;
}

export interface BoundedRedisConfig {
  readonly url: string;
  readonly timeouts: RedisTimeouts;
  readonly logger: Logger;
}

/**
 * The web app's node-redis client, connected on first use and bounded (`createLazyConnection`):
 * an outage fails a call with `RedisUnavailableError` within the timeouts, never hangs it.
 * Commands are never queued while disconnected (`disableOfflineQueue`): once connected, a lost
 * connection is re-established by node-redis while calls fail at once.
 */
export function createBoundedRedis(config: BoundedRedisConfig) {
  return createLazyConnection({
    create: () => {
      let ready = false;
      const client = createClient({
        url: config.url,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: config.timeouts.connectTimeoutMs,
          // Before the first `ready` a failed attempt ends `connect()` (false), so the lazy
          // connection destroys the client; afterwards node-redis reconnects with a capped backoff.
          reconnectStrategy: (retries) => (ready ? Math.min(50 * 2 ** retries, 2000) : false),
        },
      });
      client.on("ready", () => {
        ready = true;
      });
      // Without a listener node-redis rethrows socket errors as uncaught exceptions.
      client.on("error", (error: unknown) => {
        config.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "queue redis",
        );
      });
      return client;
    },
    connectTimeoutMs: config.timeouts.connectTimeoutMs,
    commandTimeoutMs: config.timeouts.commandTimeoutMs,
    isServerReply: (error) => error instanceof ErrorReply,
  });
}
