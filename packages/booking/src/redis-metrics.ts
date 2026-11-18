import type { BookingMetric, BookingMetrics } from "./booking-service";

/** The one Redis command the adapter needs; keeps the package free of a client dependency. */
export interface RedisMetricsClient {
  hIncrBy(key: string, field: string, increment: number): Promise<number>;
}

/** The one Redis command the reader needs. */
export interface RedisMetricsReadClient {
  hGetAll(key: string): Promise<Readonly<Record<string, string>>>;
}

/** The one Redis command the reset needs. */
export interface RedisMetricsDeleteClient {
  del(key: string): Promise<number>;
}

export type BookingMetricCounts = Readonly<Record<BookingMetric, number>>;

/** Reads an event's counters, e.g. for the admin dashboard. */
export interface BookingMetricsReader {
  read(eventId: string): Promise<BookingMetricCounts>;
}

/** Zeroes an event's counters, e.g. when the demo event is reset. */
export interface BookingMetricsReset {
  reset(eventId: string): Promise<void>;
}

function metricsKey(prefix: string, eventId: string): string {
  return `${prefix}booking:metrics:${eventId}`;
}

/** Counters live in one hash per event: `${prefix}booking:metrics:${eventId}`, field = metric. */
export function createRedisBookingMetrics(client: RedisMetricsClient, prefix = ""): BookingMetrics {
  return {
    async increment(metric, eventId) {
      await client.hIncrBy(metricsKey(prefix, eventId), metric, 1);
    },
  };
}

/** Reads the same hash the writer increments; a counter never incremented reads as 0. */
export function createRedisBookingMetricsReader(
  client: RedisMetricsReadClient,
  prefix = "",
): BookingMetricsReader {
  return {
    async read(eventId) {
      const stored = await client.hGetAll(metricsKey(prefix, eventId));
      const count = (metric: BookingMetric) => Number(stored[metric] ?? 0);
      // Listed field by field so a new BookingMetric fails to compile here until it is read.
      return {
        hold_ok: count("hold_ok"),
        seat_unavailable: count("seat_unavailable"),
        race_lost: count("race_lost"),
        booking_busy: count("booking_busy"),
        limit_exceeded: count("limit_exceeded"),
      };
    },
  };
}

/** Deletes the event's counter hash; a deleted counter reads as 0, like one never incremented. */
export function createRedisBookingMetricsReset(
  client: RedisMetricsDeleteClient,
  prefix = "",
): BookingMetricsReset {
  return {
    async reset(eventId) {
      await client.del(metricsKey(prefix, eventId));
    },
  };
}
