import type { Logger } from "@ticketarena/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  shutdownWorkerProcess,
  startWorkerProcess,
  type WorkerComponent,
} from "./lifecycle.js";

// The worker's entry point (main.ts) starts and stops through these two functions; process.exit is
// the boundary, injected here as a recorder so a test never ends the test process.

type Line = Record<string, unknown> & { level: string; msg?: string };

function recordingLogger() {
  const lines: Line[] = [];
  const make = (bound: Record<string, unknown>): Logger => {
    const writer =
      (level: string) =>
      (fields: object, msg?: string): void => {
        lines.push({ ...bound, ...fields, level, ...(msg === undefined ? {} : { msg }) });
      };
    return {
      info: writer("info"),
      warn: writer("warn"),
      error: writer("error"),
      child: (bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

function recordingExit() {
  const codes: number[] = [];
  return { exit: (code: number) => void codes.push(code), codes };
}

function recordingComponent(name: string, order: string[]): WorkerComponent {
  return {
    name,
    stop: async () => {
      order.push(name);
    },
  };
}

describe("startWorkerProcess", () => {
  it("turns a failed start into a logged error, closes the resources and exits non-zero", async () => {
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const closed: string[] = [];
    const failure = new Error("worker health server cannot listen on port 8080");

    const worker = await startWorkerProcess({
      start: async () => {
        throw failure;
      },
      resources: [[recordingComponent("bus", closed)], [recordingComponent("prisma", closed)]],
      logger,
      exit,
    });

    expect(worker).toBeUndefined();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", err: failure, msg: "worker failed to start" }),
    );
    expect(closed).toEqual(["bus", "prisma"]);
    expect(codes).toEqual([1]);
  });

  it("returns the started worker and does not exit", async () => {
    const { logger } = recordingLogger();
    const { exit, codes } = recordingExit();
    const running = { port: 1, components: [], stop: async () => undefined };

    expect(
      await startWorkerProcess({ start: async () => running, resources: [], logger, exit }),
    ).toBe(running);
    expect(codes).toEqual([]);
  });
});

describe("shutdownWorkerProcess (TD-035)", () => {
  it("stops every phase in order and exits zero", async () => {
    const { logger } = recordingLogger();
    const { exit, codes } = recordingExit();
    const order: string[] = [];

    await shutdownWorkerProcess({
      phases: [
        [recordingComponent("relay:booking", order)],
        [recordingComponent("bus", order)],
        [recordingComponent("prisma", order)],
      ],
      logger,
      exit,
    });

    expect(order).toEqual(["relay:booking", "bus", "prisma"]);
    expect(codes).toEqual([0]);
  });

  it("logs a component whose stop rejects, still closes the rest, and exits non-zero", async () => {
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const order: string[] = [];
    const failure = new Error("bus close failed");

    await shutdownWorkerProcess({
      phases: [
        [recordingComponent("relay:booking", order)],
        [
          {
            name: "bus",
            stop: async () => {
              throw failure;
            },
          },
        ],
        [recordingComponent("prisma", order)],
      ],
      logger,
      exit,
    });

    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", component: "bus", err: failure }),
    );
    expect(order).toEqual(["relay:booking", "prisma"]);
    expect(codes).toEqual([1]);
  });

  it("exits non-zero at the deadline, naming the component that did not stop", async () => {
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const order: string[] = [];

    await shutdownWorkerProcess({
      phases: [
        [
          recordingComponent("relay:payment", order),
          // A relay tick holding its claim transaction: its stop never settles.
          { name: "relay:booking", stop: () => new Promise<void>(() => undefined) },
        ],
        [recordingComponent("prisma", order)],
      ],
      logger,
      exit,
      deadlineMs: 20,
    });

    expect(codes).toEqual([1]);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", pending: ["relay:booking"], deadlineMs: 20 }),
    );
    expect(order).toEqual(["relay:payment"]);
  }, 2_000);

  it("bounds shutdown by default within Fly's 30 s kill_timeout", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(25_000);
  });
});
