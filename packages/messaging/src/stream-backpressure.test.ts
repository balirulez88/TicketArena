import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectJetStreamMessageBus, createOutboxRelay, type MessageBus } from "./index.js";

const database = setupTestDatabase();
const nats = setupTestNats();
const MAIN_STREAM = `${nats.streamPrefix}TICKETARENA`;
// Small enough that a handful of the rows below fill it, large enough for several.
const FULL_STREAM_BYTES = 4 * 1024;

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
    streamMaxBytes: { main: FULL_STREAM_BYTES },
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

/** Stands in for `max_age` expiring old messages: the stream gets its space back. */
async function freeStreamSpace(): Promise<void> {
  const connection = await connect({ servers: nats.url });
  try {
    await (await jetstreamManager(connection)).streams.purge(MAIN_STREAM);
  } finally {
    await connection.close();
  }
}

describe("a full stream (AT-35, discard: new)", () => {
  it("rejects the publish instead of dropping a stored message", async () => {
    await freeStreamSpace();
    const data = "x".repeat(512);
    let stored = 0;
    let rejection: unknown;
    while (rejection === undefined && stored < 100) {
      try {
        await bus.publish({ subject: "ta.order.placed", data, msgId: crypto.randomUUID() });
        stored += 1;
      } catch (error) {
        rejection = error;
      }
    }

    expect(stored).toBeGreaterThan(0);
    expect(String(rejection)).toMatch(/maximum bytes/i);
    const connection = await connect({ servers: nats.url });
    try {
      const info = await (await jetstreamManager(connection)).streams.info(MAIN_STREAM);
      expect(info.state.messages).toBe(stored);
      expect(info.state.first_seq).toBe(1);
    } finally {
      await connection.close();
    }
  });

  it("keeps the outbox rows PENDING until space frees, then publishes every one", async () => {
    await freeStreamSpace();
    const base = Date.now();
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    await prisma.outboxEvent.createMany({
      data: ids.map((id, index) => ({
        id,
        aggregateType: "order",
        aggregateId: crypto.randomUUID(),
        eventType: "order.placed",
        payload: { id, padding: "x".repeat(512) },
        createdAt: new Date(base + index),
      })),
    });
    const relay = createOutboxRelay({ bus, prisma });

    const firstPass = await relay.tick();

    expect(firstPass).toBeGreaterThan(0);
    expect(firstPass).toBeLessThan(ids.length);
    const waiting = await prisma.outboxEvent.findMany({ where: { status: "PENDING" } });
    expect(waiting).toHaveLength(ids.length - firstPass);
    for (const row of waiting) {
      expect(row.attempts).toBe(1);
      expect(row.lastError).toMatch(/maximum bytes/i);
    }

    // Still full: nothing more goes out and nothing is lost.
    expect(await relay.tick()).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { status: "PENDING" } })).toBe(waiting.length);

    let published = firstPass;
    for (let pass = 0; pass < ids.length && published < ids.length; pass += 1) {
      await freeStreamSpace();
      published += await relay.tick();
    }
    expect(published).toBe(ids.length);
    expect(
      await prisma.outboxEvent.count({ where: { id: { in: ids }, status: "PUBLISHED" } }),
    ).toBe(ids.length);
  });
});
