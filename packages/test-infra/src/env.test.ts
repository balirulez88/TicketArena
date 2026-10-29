import { describe, expect, it } from "vitest";
import { parseTestEnv } from "./env";

const valid = {
  TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/postgres",
  TEST_REDIS_URL: "redis://localhost:6379",
  TEST_NATS_URL: "nats://localhost:4222",
};

describe("parseTestEnv", () => {
  it("returns the three service URLs when all are set", () => {
    expect(parseTestEnv(valid)).toEqual({
      databaseUrl: valid.TEST_DATABASE_URL,
      redisUrl: valid.TEST_REDIS_URL,
      natsUrl: valid.TEST_NATS_URL,
    });
  });

  it("fails loudly, naming every missing variable, instead of letting tests skip", () => {
    expect(() => parseTestEnv({})).toThrow(
      /TEST_DATABASE_URL is not set[\s\S]*TEST_REDIS_URL is not set[\s\S]*TEST_NATS_URL is not set/,
    );
  });

  it("rejects a URL with the wrong protocol and names the variable", () => {
    expect(() => parseTestEnv({ ...valid, TEST_REDIS_URL: "http://localhost:6379" })).toThrow(
      /TEST_REDIS_URL/,
    );
  });
});
