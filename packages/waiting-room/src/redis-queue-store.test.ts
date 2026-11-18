import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRedisQueueStore } from "./index";

const redis = setupTestRedis();
const client = createClient({ url: redis.url });

beforeAll(async () => {
  await client.connect();
});

afterAll(() => {
  client.destroy();
});

function storeWith(namespace: string) {
  return createRedisQueueStore(client, { prefix: `${redis.prefix}${namespace}` });
}

describe("RedisQueueStore", () => {
  test("a pre-queue join stores its random score and a later join stores 1 + sequence, under the prefix", async () => {
    const namespace = `${redis.prefix}layout:`;
    const store = createRedisQueueStore(client, { prefix: namespace });
    const eventId = randomUUID();

    await store.join(eventId, "early", { kind: "PRE_QUEUE", score: 0.25 });
    await store.join(eventId, "late-1", { kind: "SEQUENCE" });
    await store.join(eventId, "late-2", { kind: "SEQUENCE" });

    const queueKey = `${namespace}waiting-room:{${eventId}}:queue`;
    expect(await client.zRangeWithScores(queueKey, 0, -1)).toEqual([
      { value: "early", score: 0.25 },
      { value: "late-1", score: 2 },
      { value: "late-2", score: 3 },
    ]);
    const keys = await client.keys(`*${eventId}*`);
    expect(keys.every((key) => key.startsWith(namespace))).toBe(true);
  });

  test("join returns the 1-based position and position reads it back", async () => {
    const store = storeWith("position:");
    const eventId = randomUUID();

    expect(await store.join(eventId, "a", { kind: "SEQUENCE" })).toBe(1);
    expect(await store.join(eventId, "b", { kind: "SEQUENCE" })).toBe(2);

    expect(await store.position(eventId, "b")).toBe(2);
    expect(await store.position(eventId, "nobody")).toBeNull();
  });

  test("a second join keeps the first score (ZADD NX)", async () => {
    const store = storeWith("nx:");
    const eventId = randomUUID();
    await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.9 });
    await store.join(eventId, "b", { kind: "PRE_QUEUE", score: 0.5 });

    expect(await store.join(eventId, "a", { kind: "PRE_QUEUE", score: 0.1 })).toBe(2);
    expect(await store.join(eventId, "a", { kind: "SEQUENCE" })).toBe(2);
  });

  test("leave removes the member and reports whether it was queued", async () => {
    const store = storeWith("leave:");
    const eventId = randomUUID();
    await store.join(eventId, "a", { kind: "SEQUENCE" });
    await store.join(eventId, "b", { kind: "SEQUENCE" });

    expect(await store.leave(eventId, "a")).toBe(true);
    expect(await store.leave(eventId, "a")).toBe(false);
    expect(await store.position(eventId, "a")).toBeNull();
    expect(await store.position(eventId, "b")).toBe(1);
  });

  test("stores with different prefixes do not share a queue", async () => {
    const eventId = randomUUID();
    await storeWith("one:").join(eventId, "a", { kind: "SEQUENCE" });

    expect(await storeWith("two:").position(eventId, "a")).toBeNull();
    expect(await storeWith("two:").join(eventId, "b", { kind: "SEQUENCE" })).toBe(1);
  });

  test("concurrent joins on separate connections get distinct consecutive positions", async () => {
    const namespace = "race:";
    const eventId = randomUUID();
    const connections = await Promise.all(
      Array.from({ length: 8 }, () => createClient({ url: redis.url }).connect()),
    );
    try {
      const positions = await Promise.all(
        Array.from({ length: 40 }, (_, index) => {
          const connection = connections[index % connections.length] ?? client;
          return createRedisQueueStore(connection, {
            prefix: `${redis.prefix}${namespace}`,
          }).join(eventId, `buyer-${index}`, { kind: "SEQUENCE" });
        }),
      );

      expect([...positions].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
    } finally {
      for (const connection of connections) {
        connection.destroy();
      }
    }
  });
});
