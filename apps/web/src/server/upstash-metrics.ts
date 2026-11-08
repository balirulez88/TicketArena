import {
  type BookingMetrics,
  createRedisBookingMetrics,
  type RedisMetricsClient,
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
 * Upstash REST client for the one command metrics need. Errors name the command and the cause
 * but never include the token or the request headers.
 */
export function createUpstashMetricsClient(config: UpstashClientConfig): RedisMetricsClient {
  return {
    async hIncrBy(key, field, increment) {
      let response: Response;
      try {
        response = await fetch(config.url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify(["HINCRBY", key, field, increment]),
          signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.name : "unknown error";
        throw new Error(`Upstash HINCRBY failed: request did not complete (${reason})`);
      }
      const body: unknown = await response.json().catch(() => undefined);
      const upstashError = fieldOf(body, "error");
      if (!response.ok || upstashError !== undefined) {
        throw new Error(
          `Upstash HINCRBY failed: ${String(upstashError ?? `HTTP ${response.status}`)}`,
        );
      }
      const result = fieldOf(body, "result");
      if (typeof result !== "number") {
        throw new Error("Upstash HINCRBY failed: response has no numeric result");
      }
      return result;
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
 * Builds the metrics dependency on first call and caches the outcome, success or failure.
 * A bad configuration is logged once, at the boundary, and every later call rethrows the same
 * error without re-reading the environment.
 */
export function createLazyMetrics({ readEnv, logger }: LazyMetricsConfig): () => BookingMetrics {
  let outcome: { metrics: BookingMetrics } | { failure: Error } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        const env = parseMetricsEnv(readEnv());
        outcome = {
          metrics: createRedisBookingMetrics(
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
    return outcome.metrics;
  };
}
