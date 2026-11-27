import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectJetStreamMessageBus, createOutboxRelay, type MessageBus } from "./index.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

type Bindings = Record<string, unknown>;
type Line = Bindings & { readonly level: "info" | "warn" | "error"; readonly msg?: string };

function recordingLogger() {
  const lines: Line[] = [];
  const make = (bound: Bindings) => {
    const writer =
      (level: Line["level"]) =>
      (fields: object, msg?: string): void => {
        lines.push({ ...bound, ...fields, level, ...(msg === undefined ? {} : { msg }) });
      };
    return {
      info: writer("info"),
      warn: writer("warn"),
      error: writer("error"),
      child: (bindings: Bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

/**
 * The database boundary with a switchable outage: while `down`, every claim transaction rejects
 * the way an unreachable database does; everything else is the real client.
 */
function outagePrisma(real: PrismaClient) {
  const state = { down: true, attempts: 0 };
  const client = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "$transaction") {
        return (...args: Parameters<PrismaClient["$transaction"]>) => {
          state.attempts += 1;
          if (state.down) {
            return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
          }
          return Reflect.apply(target.$transaction, target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { client, state };
}

async function seedPending(): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.outboxEvent.create({
    data: {
      id,
      aggregateType: "order",
      aggregateId: crypto.randomUUID(),
      eventType: "order.placed",
      payload: { id, type: "order.placed" },
    },
  });
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  return (await prisma.outboxEvent.findUnique({ where: { id } }))?.status;
}

function relayFailures(lines: readonly Line[]): Line[] {
  return lines.filter(
    (line) => line["component"] === "outbox-relay" && line.msg === "outbox relay tick failed",
  );
}

describe("outbox relay logging", () => {
  it("logs a published row with the payload envelope's correlationId, causationId and ids", async () => {
    const { logger, lines } = recordingLogger();
    const id = crypto.randomUUID();
    const ids = {
      correlationId: crypto.randomUUID(),
      causationId: crypto.randomUUID(),
      holdId: crypto.randomUUID(),
      orderId: crypto.randomUUID(),
    };
    await prisma.outboxEvent.create({
      data: {
        id,
        aggregateType: "order",
        aggregateId: ids.orderId,
        eventType: "order.placed",
        payload: {
          id,
          type: "order.placed",
          version: 1,
          occurredAt: new Date().toISOString(),
          ...ids,
          payload: {},
        },
      },
    });

    await createOutboxRelay({ bus, prisma, logger }).tick();

    const mine = lines.filter((line) => line["outboxId"] === id);
    expect(mine.length).toBeGreaterThan(0);
    for (const line of mine) {
      expect(line).toMatchObject(ids);
    }
  });

  it("logs a tick that fails outside a row's publish at error with the cause, keeps running and publishes once the outage ends (TD-031)", async () => {
    const { logger, lines } = recordingLogger();
    const outage = outagePrisma(prisma);
    const id = await seedPending();
    const relay = createOutboxRelay({ bus, prisma: outage.client, logger, intervalMs: 1 });

    relay.start();
    try {
      await vi.waitFor(() => expect(outage.state.attempts).toBeGreaterThanOrEqual(3));
      const [failure] = relayFailures(lines);
      expect(failure?.level).toBe("error");
      expect(failure?.["err"]).toBeInstanceOf(Error);
      expect(failure?.["err"]).toMatchObject({ message: expect.stringContaining("ECONNREFUSED") });
      expect(await statusOf(id)).toBe("PENDING");

      outage.state.down = false;
      await vi.waitFor(async () => expect(await statusOf(id)).toBe("PUBLISHED"));
    } finally {
      await relay.stop();
    }
  });

  it("rate-limits identical failures during a sustained outage and logs the first success after them (TD-031)", async () => {
    const { logger, lines } = recordingLogger();
    const outage = outagePrisma(prisma);
    let clock = 1_000_000;
    const relay = createOutboxRelay({
      bus,
      prisma: outage.client,
      logger,
      intervalMs: 1,
      now: () => clock,
    });

    relay.start();
    try {
      await vi.waitFor(() => expect(outage.state.attempts).toBeGreaterThanOrEqual(10));
      expect(relayFailures(lines)).toHaveLength(1);

      // Inside the window: still one line however many ticks fail.
      clock += 30_000;
      const seen = outage.state.attempts;
      await vi.waitFor(() => expect(outage.state.attempts).toBeGreaterThanOrEqual(seen + 10));
      expect(relayFailures(lines)).toHaveLength(1);

      // Past the window: one more line that counts the failures it stood for.
      clock += 30_000;
      const before = outage.state.attempts;
      await vi.waitFor(() => expect(relayFailures(lines)).toHaveLength(2));
      expect(relayFailures(lines)[1]?.["suppressed"]).toBeGreaterThanOrEqual(before - 2);

      clock += 5_000;
      const failedTicks = outage.state.attempts;
      outage.state.down = false;
      await vi.waitFor(() =>
        expect(
          lines.filter((line) => line.msg === "outbox relay recovered" && line.level === "info"),
        ).toHaveLength(1),
      );
      const recovered = lines.find((line) => line.msg === "outbox relay recovered");
      expect(recovered?.["failures"]).toBeGreaterThanOrEqual(failedTicks);
      expect(recovered?.["outageMs"]).toBe(65_000);
      expect(relayFailures(lines)).toHaveLength(2);
    } finally {
      await relay.stop();
    }
  });
});
