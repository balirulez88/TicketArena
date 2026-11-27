import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createRedisBookingMetrics,
  createRedisBookingMetricsReader,
  createRedisBookingMetricsReset,
} from "./index";

const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });

beforeAll(async () => {
  await redisClient.connect();
});

afterAll(() => {
  redisClient.destroy();
});

describe("createRedisBookingMetricsReader", () => {
  test("reads back every counter the writer incremented for the event, zero for the rest", async () => {
    const eventId = randomUUID();
    const metrics = createRedisBookingMetrics(redisClient, redis.prefix);
    await metrics.increment("hold_ok", eventId);
    await metrics.increment("hold_ok", eventId);
    await metrics.increment("race_lost", eventId);
    await metrics.increment("hold_ok", randomUUID());

    const read = await createRedisBookingMetricsReader(redisClient, redis.prefix).read(eventId);

    expect(read).toEqual({
      hold_ok: 2,
      seat_unavailable: 0,
      race_lost: 1,
      booking_busy: 0,
      deadlock_retry: 0,
      limit_exceeded: 0,
      late_delivery_refund: 0,
    });
  });

  test("reads the dashboard's deadlock_retry and the saga's late_delivery_refund too", async () => {
    const eventId = randomUUID();
    const metrics = createRedisBookingMetrics(redisClient, redis.prefix);
    await metrics.increment("deadlock_retry", eventId);
    await metrics.increment("late_delivery_refund", eventId);
    await metrics.increment("late_delivery_refund", eventId);

    const read = await createRedisBookingMetricsReader(redisClient, redis.prefix).read(eventId);

    expect(read).toMatchObject({ deadlock_retry: 1, late_delivery_refund: 2 });
  });

  test("an event with no counters reads as all zeros", async () => {
    const read = await createRedisBookingMetricsReader(redisClient, redis.prefix).read(
      randomUUID(),
    );

    expect(Object.values(read).every((value) => value === 0)).toBe(true);
  });
});

describe("createRedisBookingMetrics", () => {
  test("counts the saga's payment_attempt_failed in the event's hash without disturbing the hold counters", async () => {
    const eventId = randomUUID();
    const metrics = createRedisBookingMetrics(redisClient, redis.prefix);

    await metrics.increment("payment_attempt_failed", eventId);
    await metrics.increment("payment_attempt_failed", eventId);

    expect(
      await redisClient.hGet(`${redis.prefix}booking:metrics:${eventId}`, "payment_attempt_failed"),
    ).toBe("2");
    expect(
      Object.values(await createRedisBookingMetricsReader(redisClient, redis.prefix).read(eventId)),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("createRedisBookingMetricsReset", () => {
  test("zeroes every counter of the event and leaves other events' counters alone", async () => {
    const eventId = randomUUID();
    const otherId = randomUUID();
    const metrics = createRedisBookingMetrics(redisClient, redis.prefix);
    await metrics.increment("hold_ok", eventId);
    await metrics.increment("seat_unavailable", eventId);
    await metrics.increment("hold_ok", otherId);

    await createRedisBookingMetricsReset(redisClient, redis.prefix).reset(eventId);

    const reader = createRedisBookingMetricsReader(redisClient, redis.prefix);
    expect(Object.values(await reader.read(eventId)).every((value) => value === 0)).toBe(true);
    expect((await reader.read(otherId)).hold_ok).toBe(1);
  });
});
