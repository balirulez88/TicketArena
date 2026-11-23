import type { RedisMetricsClient } from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";
import { createLazyConnection, type RedisQueueClient } from "@ticketarena/waiting-room";
import { createClient, ErrorReply } from "redis";

export interface RedisTimeouts {
  /** Bound on opening a connection, handshake included (ms). */
  readonly connectTimeoutMs: number;
  /** Bound on one command, from the call until its reply (ms). */
  readonly commandTimeoutMs: number;
}

export interface WorkerRedisConfig {
  readonly url: string;
  readonly timeouts: RedisTimeouts;
  readonly logger: Logger;
}

export interface WorkerRedis {
  /** For the waiting-room queue store (admission ticker and reaper). */
  readonly queueClient: RedisQueueClient;
  /** For the saga's best-effort counters. */
  readonly metricsClient: RedisMetricsClient;
  /** Resolves when Redis answers a PING within the timeouts; rejects otherwise. */
  readonly ping: () => Promise<void>;
  readonly close: () => void;
}

/**
 * The worker's one node-redis client, connected on first use, never at start (ticket 63): Redis
 * decides only queue order and admission (ADR 0005), so the relay, the consumers and the sweeper
 * must run while it is down. Every call is bounded (`createLazyConnection`): connecting by
 * `connectTimeoutMs`, a command by `commandTimeoutMs`, and no command is queued while the client
 * is disconnected. A failed call fails one loop pass, which the loop logs and retries.
 */
export function createWorkerRedis(config: WorkerRedisConfig): WorkerRedis {
  const connection = createLazyConnection({
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

  return {
    queueClient: {
      eval: (script, options) => connection.run((client) => client.eval(script, options)),
      zRank: (key, member) => connection.run((client) => client.zRank(key, member)),
    },
    metricsClient: {
      hIncrBy: (key, field, increment) =>
        connection.run((client) => client.hIncrBy(key, field, increment)),
    },
    ping: async () => {
      await connection.run((client) => client.ping());
    },
    close: () => connection.close(),
  };
}
