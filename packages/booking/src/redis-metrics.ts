import type { BookingMetrics } from "./booking-service";

/** The one Redis command the adapter needs; keeps the package free of a client dependency. */
export interface RedisMetricsClient {
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
}

/** Counters live in one hash per event: `${prefix}booking:metrics:${eventId}`, field = metric. */
export function createRedisBookingMetrics(client: RedisMetricsClient, prefix = ""): BookingMetrics {
  return {
    async increment(metric, eventId) {
      await client.hIncrBy(`${prefix}booking:metrics:${eventId}`, metric, 1);
    },
  };
}
