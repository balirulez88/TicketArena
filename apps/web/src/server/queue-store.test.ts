import { randomUUID } from "node:crypto";
import { type Logger, silentLogger } from "@ticketarena/contracts";
import { setupTestRedis } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { createLazyQueueStore } from "./queue-store";

const redis = setupTestRedis();

describe("createLazyQueueStore", () => {
  test("connects to REDIS_URL on first use and hands out one shared store", async () => {
    const queueStore = createLazyQueueStore({
      readEnv: () => ({ REDIS_URL: redis.url }),
      logger: silentLogger,
      prefix: redis.prefix,
    });
    const eventId = randomUUID();

    const store = await queueStore();
    await store.join(eventId, "a", { kind: "SEQUENCE" });

    expect(await queueStore()).toBe(store);
    expect(await (await queueStore()).position(eventId, "a")).toBe(1);
  });

  test("an invalid REDIS_URL fails naming the variable, is logged once and is not re-read", async () => {
    const errors: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      error: (_fields, message) => {
        errors.push(message ?? "");
      },
    };
    let reads = 0;
    const queueStore = createLazyQueueStore({
      readEnv: () => {
        reads += 1;
        return { REDIS_URL: "https://not-redis.example" };
      },
      logger,
      prefix: "",
    });

    await expect(queueStore()).rejects.toThrow(/REDIS_URL/);
    await expect(queueStore()).rejects.toThrow(/REDIS_URL/);

    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
