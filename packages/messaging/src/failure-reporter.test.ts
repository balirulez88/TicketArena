import type { Logger } from "@ticketarena/contracts";
import { describe, expect, it } from "vitest";
import {
  createFailureReporter,
  FAILURE_LOG_WINDOW_MS,
  MAX_TRACKED_FAILURE_CAUSES,
} from "./failure-reporter.js";

type Line = Record<string, unknown> & { readonly level: "info" | "warn" | "error"; msg?: string };

function recordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const writer =
    (level: Line["level"]) =>
    (fields: object, msg?: string): void => {
      lines.push({ ...fields, level, ...(msg === undefined ? {} : { msg }) });
    };
  const logger: Logger = {
    info: writer("info"),
    warn: writer("warn"),
    error: writer("error"),
    child: () => logger,
  };
  return { logger, lines };
}

function setup() {
  const { logger, lines } = recordingLogger();
  const clock = { now: 1_000_000 };
  const reporter = createFailureReporter({
    logger,
    now: () => clock.now,
    failureMessage: "loop failed",
    recoveryMessage: "loop recovered",
  });
  const failuresOf = (cause: string) =>
    lines.filter(
      (line) =>
        line.msg === "loop failed" &&
        line.level === "error" &&
        line["err"] instanceof Error &&
        line["err"].message === cause,
    );
  return { lines, clock, reporter, failuresOf };
}

describe("failure reporter", () => {
  it("rate-limits each cause in its own window when causes alternate, then logs one recovery line", () => {
    const { lines, clock, reporter, failuresOf } = setup();

    // A, B, A, B, ... inside one window: each cause is logged once, at its first occurrence.
    for (let i = 0; i < 10; i += 1) {
      reporter.failed(new Error(i % 2 === 0 ? "A" : "B"));
      clock.now += 1_000;
    }
    expect(failuresOf("A")).toHaveLength(1);
    expect(failuresOf("B")).toHaveLength(1);

    // Past A's window (A first logged at t0, B at t0 + 1 s): A repeats, B is still inside its own.
    clock.now = 1_000_000 + FAILURE_LOG_WINDOW_MS;
    reporter.failed(new Error("A"));
    reporter.failed(new Error("B"));
    expect(failuresOf("A")).toHaveLength(2);
    expect(failuresOf("A")[1]?.["suppressed"]).toBe(4);
    expect(failuresOf("B")).toHaveLength(1);

    clock.now += 1_000;
    reporter.failed(new Error("B"));
    expect(failuresOf("B")).toHaveLength(2);
    expect(failuresOf("B")[1]?.["suppressed"]).toBe(5);

    clock.now += 4_000;
    reporter.succeeded();
    const recoveries = lines.filter((line) => line.msg === "loop recovered");
    expect(recoveries).toEqual([
      {
        level: "info",
        msg: "loop recovered",
        failures: 13,
        outageMs: FAILURE_LOG_WINDOW_MS + 5_000,
      },
    ]);

    // A new outage starts fresh: its first failure is logged again.
    reporter.failed(new Error("A"));
    expect(failuresOf("A")).toHaveLength(3);
  });

  it("keeps the per-cause window bounded, forgetting the least recently logged cause first", () => {
    const { clock, reporter, failuresOf } = setup();

    for (let i = 0; i <= MAX_TRACKED_FAILURE_CAUSES; i += 1) {
      reporter.failed(new Error(`cause-${i}`));
      clock.now += 1;
    }

    // One cause more than the bound: the oldest was evicted, so it is logged again in its window.
    reporter.failed(new Error("cause-0"));
    expect(failuresOf("cause-0")).toHaveLength(2);

    // The most recently logged cause is still tracked and stays suppressed.
    reporter.failed(new Error(`cause-${MAX_TRACKED_FAILURE_CAUSES}`));
    expect(failuresOf(`cause-${MAX_TRACKED_FAILURE_CAUSES}`)).toHaveLength(1);
  });
});
