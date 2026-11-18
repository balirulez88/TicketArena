import {
  type BookingMetrics,
  type BookingMetricsReader,
  createRedisBookingMetrics,
  createRedisBookingMetricsReader,
  type RedisMetricsClient,
  type RedisMetricsReadClient,
} from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";
import { parseMetricsEnv } from "./env";

const DEFAULT_TIMEOUT_MS = 2000;

interface UpstashClientConfig {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

/**
 * Upstash REST client for the commands metrics need. Errors name the command and the cause but
 * never include the token or the request headers.
 */
export function createUpstashMetricsClient(
  config: UpstashClientConfig,
): RedisMetricsClient & RedisMetricsReadClient {
  async function command(args: readonly (string | number)[]): Promise<unknown> {
    const name = String(args[0]);
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new Error(`Upstash ${name} failed: request did not complete (${reason})`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const upstashError = fieldOf(body, "error");
    if (!response.ok || upstashError !== undefined) {
      throw new Error(
        `Upstash ${name} failed: ${String(upstashError ?? `HTTP ${response.status}`)}`,
      );
    }
    return fieldOf(body, "result");
  }

  return {
    async hIncrBy(key, field, increment) {
      const result = await command(["HINCRBY", key, field, increment]);
      if (typeof result !== "number") {
        throw new Error("Upstash HINCRBY failed: response has no numeric result");
      }
      return result;
    },
    async hGetAll(key) {
      // The REST protocol returns a hash as a flat [field, value, field, value, ...] array.
      const result = await command(["HGETALL", key]);
      if (!Array.isArray(result)) {
        throw new Error("Upstash HGETALL failed: response has no array result");
      }
      const record: Record<string, string> = {};
      for (let i = 0; i + 1 < result.length; i += 2) {
        record[String(result[i])] = String(result[i + 1]);
      }
      return record;
    },
  };
}

function fieldOf(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null
    ? Object.entries(body).find(([key]) => key === name)?.[1]
    : undefined;
}

interface LazyMetricsConfig {
  readonly readEnv: () => Readonly<Record<string, string | undefined>>;
  readonly logger: Logger;
}

/**
 * Builds a dependency on first call and caches the outcome, success or failure. A bad
 * configuration is logged once, at the boundary, and every later call rethrows the same error
 * without re-reading the environment.
 */
function lazyFromUpstash<T>(
  { readEnv, logger }: LazyMetricsConfig,
  build: (client: RedisMetricsClient & RedisMetricsReadClient) => T,
): () => T {
  let outcome: { value: T } | { failure: Error } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        const env = parseMetricsEnv(readEnv());
        outcome = {
          value: build(
            createUpstashMetricsClient({
              url: env.UPSTASH_REDIS_REST_URL,
              token: env.UPSTASH_REDIS_REST_TOKEN,
            }),
          ),
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error({ err: failure.message }, "metrics configuration is invalid");
        outcome = { failure };
      }
    }
    if ("failure" in outcome) {
      throw outcome.failure;
    }
    return outcome.value;
  };
}

/** The booking counters writer, built lazily so only procedures that record metrics need Upstash. */
export function createLazyMetrics(config: LazyMetricsConfig): () => BookingMetrics {
  return lazyFromUpstash(config, (client) => createRedisBookingMetrics(client));
}

/** The booking counters reader for the admin snapshot, built lazily like the writer. */
export function createLazyMetricsReader(config: LazyMetricsConfig): () => BookingMetricsReader {
  return lazyFromUpstash(config, (client) => createRedisBookingMetricsReader(client));
}
