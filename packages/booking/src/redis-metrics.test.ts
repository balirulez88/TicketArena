import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRedisBookingMetrics, createRedisBookingMetricsReader } from "./index";

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
      limit_exceeded: 0,
    });
  });

  test("an event with no counters reads as all zeros", async () => {
    const read = await createRedisBookingMetricsReader(redisClient, redis.prefix).read(
      randomUUID(),
    );

    expect(Object.values(read).every((value) => value === 0)).toBe(true);
  });
});
