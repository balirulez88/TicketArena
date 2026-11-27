import type { BookingMetric, BookingMetrics } from "./booking-service";
import type { SagaMetric, SagaMetrics } from "./payment-saga";

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

/**
 * The counters the admin dashboard reads (spec: Admin dashboard): every booking outcome,
 * `deadlock_retry` as the contention signal, and the saga's `late_delivery_refund`, which makes
 * the settlement grace's trade-off visible. `payment_attempt_failed` stays in the hash only.
 */
type DashboardMetric = BookingMetric | Exclude<SagaMetric, "payment_attempt_failed">;

export type BookingMetricCounts = Readonly<Record<DashboardMetric, number>>;

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

/**
 * Counters live in one hash per event: `${prefix}booking:metrics:${eventId}`, field = metric.
 * The saga's counters share the hash; the reader reads only the counters the dashboard shows.
 */
export function createRedisBookingMetrics(
  client: RedisMetricsClient,
  prefix = "",
): BookingMetrics & SagaMetrics {
  return {
    async increment(metric: BookingMetric | SagaMetric, eventId: string) {
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
      const count = (metric: DashboardMetric) => Number(stored[metric] ?? 0);
      // Listed field by field so a new dashboard metric fails to compile here until it is read.
      return {
        hold_ok: count("hold_ok"),
        seat_unavailable: count("seat_unavailable"),
        race_lost: count("race_lost"),
        booking_busy: count("booking_busy"),
        deadlock_retry: count("deadlock_retry"),
        limit_exceeded: count("limit_exceeded"),
        late_delivery_refund: count("late_delivery_refund"),
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
