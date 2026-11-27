import type { Logger } from "@ticketarena/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a failed start into a logged error, closes the resources and exits non-zero", async () => {
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const closed: string[] = [];
    const failure = new Error("worker health server cannot listen on port 8080");

    const started = await startWorkerProcess({
      start: async (opened) => {
        opened(recordingComponent("prisma", closed));
        opened(recordingComponent("bus", closed));
        throw failure;
      },
      logger,
      exit,
    });

    expect(started).toBeUndefined();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", err: failure, msg: "worker failed to start" }),
    );
    // Closed in reverse order of opening: the bus before the database it relays from.
    expect(closed).toEqual(["bus", "prisma"]);
    expect(codes).toEqual([1]);
  });

  it("closes what was opened before the NATS connect failed, and exits non-zero", async () => {
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const closed: string[] = [];
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:4222");

    await startWorkerProcess({
      start: async (opened) => {
        opened(recordingComponent("prisma", closed));
        opened(recordingComponent("redis", closed));
        throw refused;
      },
      logger,
      exit,
    });

    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", err: refused, msg: "worker failed to start" }),
    );
    expect(closed).toEqual(["redis", "prisma"]);
    expect(codes).toEqual([1]);
  });

  it("bounds the cleanup of a failed start by the 25 s budget, naming the resource that did not close", async () => {
    vi.useFakeTimers();
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const closed: string[] = [];

    const outcome = startWorkerProcess({
      start: async (opened) => {
        opened(recordingComponent("prisma", closed));
        opened({ name: "bus", stop: () => new Promise<void>(() => undefined) });
        throw new Error("subscribe refused");
      },
      logger,
      exit,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_DEADLINE_MS - 1);
    expect(codes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeUndefined();
    expect(codes).toEqual([1]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "error",
        pending: ["bus"],
        deadlineMs: DEFAULT_SHUTDOWN_DEADLINE_MS,
      }),
    );
    expect(closed).toEqual([]);
  });

  it("spends one 25 s budget on the worker's cleanup and the resources: a stuck component and a stuck resource exit at 25 s, not 50 s", async () => {
    vi.useFakeTimers();
    const { logger, lines } = recordingLogger();
    const { exit, codes } = recordingExit();
    const never = () => new Promise<void>(() => undefined);

    const outcome = startWorkerProcess({
      // What startWorker does on a failed start: stop what it started from the shared budget, then reject.
      start: async (opened, stopBudget) => {
        opened({ name: "bus", stop: never });
        await stopBudget.stop([[{ name: "consumer:stuck", stop: never }]], logger);
        throw new Error("subscribe refused");
      },
      logger,
      exit,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_DEADLINE_MS - 1);
    expect(codes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeUndefined();
    expect(codes).toEqual([1]);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: "error", pending: ["consumer:stuck"] }),
    );
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", pending: ["bus"] }));
  });

  it("returns the started worker with its resources in stop order, and does not exit", async () => {
    const { logger } = recordingLogger();
    const { exit, codes } = recordingExit();
    const running = { port: 1, components: [], stop: async () => undefined };
    const prisma = recordingComponent("prisma", []);
    const bus = recordingComponent("bus", []);

    expect(
      await startWorkerProcess({
        start: async (opened) => {
          opened(prisma);
          opened(bus);
          return running;
        },
        logger,
        exit,
      }),
    ).toEqual({ worker: running, resources: [[bus], [prisma]] });
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
