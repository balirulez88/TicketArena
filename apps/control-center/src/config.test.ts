import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig", () => {
  it("defaults to the main ref on loopback", () => {
    expect(parseConfig([], {}, "/repo")).toEqual({
      root: "/repo",
      ref: "main",
      host: "127.0.0.1",
      port: 4319,
      staleAfterMs: 15 * 60_000,
      refreshSeconds: 30,
      failureLimit: 25,
    });
  });

  it("lets flags override environment variables", () => {
    const config = parseConfig(
      ["--port", "5000", "--ref", "integration/harness-branches"],
      { RALPH_CC_PORT: "4000", RALPH_CC_ROOT: "/other", RALPH_CC_STALE_AFTER_MINUTES: "5" },
      "/repo",
    );
    expect(config).toMatchObject({
      root: "/other",
      ref: "integration/harness-branches",
      port: 5000,
      staleAfterMs: 5 * 60_000,
    });
  });

  it("refuses a non-loopback host, naming the setting", () => {
    expect(() => parseConfig(["--host", "0.0.0.0"], {}, "/repo")).toThrow(
      /--host \(RALPH_CC_HOST\) must be one of 127\.0\.0\.1/,
    );
  });

  it("refuses unknown flags and malformed values", () => {
    expect(() => parseConfig(["--write"], {}, "/repo")).toThrow(
      /unknown or incomplete option --write/,
    );
    expect(() => parseConfig(["--ref", "main; rm -rf"], {}, "/repo")).toThrow(/--ref/);
    expect(() => parseConfig([], { RALPH_CC_PORT: "99999" }, "/repo")).toThrow(/--port/);
  });
});
