import { describe, expect, test } from "vitest";
import { parseServerEnv } from "./env";

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@db.example.com/ticketarena?sslmode=require",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "token",
  SESSION_SECRET: "s".repeat(32),
};

describe("parseServerEnv", () => {
  test("accepts a complete, well-formed environment", () => {
    expect(parseServerEnv(validEnv).UPSTASH_REDIS_REST_TOKEN).toBe("token");
  });

  test("names the missing variable when configuration is incomplete", () => {
    const { UPSTASH_REDIS_REST_TOKEN: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
  });

  test("rejects a database URL that is not Postgres", () => {
    expect(() => parseServerEnv({ ...validEnv, DATABASE_URL: "mysql://db.example.com/x" })).toThrow(
      /DATABASE_URL/,
    );
  });

  test("names SESSION_SECRET when it is missing", () => {
    const { SESSION_SECRET: _omitted, ...incomplete } = validEnv;
    expect(() => parseServerEnv(incomplete)).toThrow(/SESSION_SECRET/);
  });

  test("names SESSION_SECRET when it is shorter than 32 bytes", () => {
    expect(() => parseServerEnv({ ...validEnv, SESSION_SECRET: "short" })).toThrow(
      /SESSION_SECRET/,
    );
  });
});
