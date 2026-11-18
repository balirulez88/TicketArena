import { describe, expect, it } from "vitest";
import { setupTestUpstash } from "./index";

const upstash = setupTestUpstash();

describe("setupTestUpstash", () => {
  it("hands out a unique per-file key prefix", () => {
    expect(upstash.prefix).toMatch(/^test:[0-9a-f]{8}:$/);
  });

  it("reaches an Upstash-compatible REST endpoint that runs Lua scripts atomically", async () => {
    const key = `${upstash.prefix}counter`;
    const script = "return redis.call('INCRBY', KEYS[1], ARGV[1])";
    await Promise.all(
      Array.from({ length: 20 }, () => upstash.command(["EVAL", script, "1", key, "2"])),
    );
    expect(await upstash.command(["GET", key])).toBe("40");
  });

  it("rejects a failing command with the endpoint's error", async () => {
    await expect(upstash.command(["NOSUCHCOMMAND"])).rejects.toThrow(/NOSUCHCOMMAND/i);
  });
});
