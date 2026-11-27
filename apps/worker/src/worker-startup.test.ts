import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@ticketarena/db";
import { createPrismaClient } from "@ticketarena/db";
import { connectJetStreamMessageBus, type MessageBus } from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorker } from "./worker.js";

// TD-034: a worker that fails to start must leave no relay or consumer runner working against
// resources its caller is about to close.
const database = setupTestDatabase();
const nats = setupTestNats();

/** Long enough for a leaked relay (20 ms interval) or runner (5 ms fetches) to act many times. */
const QUIET_MS = 300;

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

/**
 * The real bus with its publishes counted and the broker's pull replaced by an empty batch after
 * 5 ms, so a running consumer runner fetches continuously. `failSubscribe` makes that consumer's
 * subscribe reject once `ready` resolves.
 */
function probingBus(failSubscribe?: { consumer: string; ready: () => Promise<void> }) {
  const counts = { publishes: 0, fetches: 0 };
  let firstFetch: () => void = () => undefined;
  const fetched = new Promise<void>((resolve) => {
    firstFetch = resolve;
  });
  const probe: MessageBus = {
    ensureTopology: () => bus.ensureTopology(),
    close: () => bus.close(),
    publish: async (input) => {
      counts.publishes += 1;
      return bus.publish(input);
    },
    subscribe: async (spec) => {
      if (spec.consumer === failSubscribe?.consumer) {
        await failSubscribe.ready();
        throw new Error(`subscribe ${spec.consumer} refused`);
      }
      return {
        fetch: async () => {
          counts.fetches += 1;
          firstFetch();
          await new Promise((resolve) => setTimeout(resolve, 5));
          return [];
        },
      };
    },
  };
  return { bus: probe, counts, fetched };
}

async function pendingOutboxRow(): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.outboxEvent.create({
    data: { id, aggregateType: "order", aggregateId: id, eventType: "order.placed", payload: {} },
  });
  return id;
}

const consumer = (name: string) => ({
  consumer: `${name}-${crypto.randomUUID()}`,
  filterSubject: "ta.order.>",
  handler: async () => undefined,
});

async function outboxStatus(id: string): Promise<string> {
  return (await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).status;
}

/** Snapshots the counters, waits QUIET_MS, and returns both snapshots for comparison. */
async function activityDuringQuiet(counts: { publishes: number; fetches: number }) {
  const before = { ...counts };
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  return { before, after: { ...counts } };
}

describe("startWorker cleanup on a failed start (TD-034)", () => {
  let blocker: Server;

  beforeAll(async () => {
    blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("rejects naming a health port that is in use, and leaves no relay, consumer runner or reconciler running", async () => {
    const port = (blocker.address() as AddressInfo).port;
    const probe = probingBus();
    const row = await pendingOutboxRow();
    let reconciles = 0;

    await expect(
      startWorker({
        bus: probe.bus,
        prisma,
        port,
        relay: { intervalMs: 20 },
        consumers: [consumer("startup-port")],
        reconciler: {
          booking: {
            reconcileRefunds: async () => {
              reconciles += 1;
              return { reEmitted: [], escalated: [] };
            },
          },
          intervalMs: 20,
        },
      }),
    ).rejects.toThrow(new RegExp(`port ${port}`));

    const { before, after } = await activityDuringQuiet(probe.counts);
    expect(after).toEqual(before);
    expect(await outboxStatus(row)).toBe("PENDING");
    expect(reconciles).toBe(0);
  });

  it("stops the relay and the runners already started when a later step throws, before the error propagates", async () => {
    const bad = consumer("startup-bad");
    let relayed: () => void = () => undefined;
    const published = new Promise<void>((resolve) => {
      relayed = resolve;
    });
    const probe = probingBus({
      consumer: bad.consumer,
      // Fail only once the relay has published and a runner has fetched: both are running.
      ready: async () => {
        await Promise.all([published, probe.fetched]);
      },
    });
    const first = await pendingOutboxRow();
    const countingBus: MessageBus = {
      ...probe.bus,
      publish: async (input) => {
        const ack = await probe.bus.publish(input);
        relayed();
        return ack;
      },
    };

    await expect(
      startWorker({
        bus: countingBus,
        prisma,
        port: 0,
        relay: { intervalMs: 20 },
        consumers: [consumer("startup-good"), bad],
      }),
    ).rejects.toThrow(`subscribe ${bad.consumer} refused`);
    expect(await outboxStatus(first)).toBe("PUBLISHED");
    expect(probe.counts.fetches).toBeGreaterThan(0);

    const later = await pendingOutboxRow();
    const { before, after } = await activityDuringQuiet(probe.counts);
    expect(after).toEqual(before);
    expect(await outboxStatus(later)).toBe("PENDING");
  });
});
