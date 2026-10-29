import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestRedis } from "./index";

const redis = setupTestRedis();
const client = createClient({ url: redis.url });

beforeAll(async () => {
  await client.connect();
});
afterAll(() => {
  client.destroy();
});

describe("setupTestRedis", () => {
  it("hands out a unique per-file key prefix", () => {
    expect(redis.prefix).toMatch(/^test:[0-9a-f]{8}:$/);
  });

  it("reaches a real Redis 7 that runs Lua scripts atomically", async () => {
    const info = await client.info("server");
    expect(info).toMatch(/redis_version:7\./);

    const key = `${redis.prefix}counter`;
    const script = "return redis.call('INCRBY', KEYS[1], ARGV[1])";
    await Promise.all(
      Array.from({ length: 50 }, () => client.eval(script, { keys: [key], arguments: ["2"] })),
    );
    expect(await client.get(key)).toBe("100");
  });
});
