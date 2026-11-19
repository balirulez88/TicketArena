import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRedisQueueStore } from "./index";
import { describeQueueStoreContract } from "./queue-store-contract";

const T0 = new Date("2027-05-01T10:00:00.000Z");

const redis = setupTestRedis();
const client = createClient({ url: redis.url });

beforeAll(async () => {
  await client.connect();
});

afterAll(() => {
  client.destroy();
});

describeQueueStoreContract("node-redis", redis.prefix, {
  store: (prefix) => createRedisQueueStore(client, { prefix }),
  async independentStores(prefix, count) {
    const connections = await Promise.all(
      Array.from({ length: count }, () => createClient({ url: redis.url }).connect()),
    );
    return {
      stores: connections.map((connection) => createRedisQueueStore(connection, { prefix })),
      close() {
        for (const connection of connections) {
          connection.destroy();
        }
      },
    };
  },
});

describe("RedisQueueStore", () => {
  test("a pre-queue join stores its random score and a later join stores 1 + sequence, under the prefix", async () => {
    const namespace = `${redis.prefix}layout:`;
    const store = createRedisQueueStore(client, { prefix: namespace });
    const eventId = randomUUID();

    await store.join(eventId, "early", { kind: "PRE_QUEUE", score: 0.25 }, T0);
    await store.join(eventId, "late-1", { kind: "SEQUENCE" }, T0);
    await store.join(eventId, "late-1", { kind: "SEQUENCE" }, T0);
    await store.join(eventId, "late-2", { kind: "SEQUENCE" }, T0);

    const queueKey = `${namespace}waiting-room:{${eventId}}:queue`;
    expect(await client.zRangeWithScores(queueKey, 0, -1)).toEqual([
      { value: "early", score: 0.25 },
      { value: "late-1", score: 2 },
      { value: "late-2", score: 3 },
    ]);
    const keys = await client.keys(`*${eventId}*`);
    expect(keys.every((key) => key.startsWith(namespace))).toBe(true);
  });
});
