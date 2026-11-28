import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupNatsStandIn, setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createOutboxRelay,
  type MessageBus,
  readOutboxHistory,
} from "./index.js";

// A real broker outage: the relay's connection runs through a TCP stand-in that the test stops,
// so the client loses its connection and every reconnect is refused, as when NATS is down.
const database = setupTestDatabase();
const nats = setupTestNats();
const standIn = setupNatsStandIn();
const MAIN_STREAM = `${nats.streamPrefix}TICKETARENA`;
const CAP = 2;

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: standIn.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
    requestTimeoutMs: 300,
    reconnectTimeWaitMs: 50,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await standIn.setMode("forward");
  await bus.close();
  await prisma.$disconnect();
});

async function storedMsgIds(): Promise<string[]> {
  const connection = await connect({ servers: nats.url });
  try {
    const manager = await jetstreamManager(connection);
    const info = await manager.streams.info(MAIN_STREAM);
    const ids: string[] = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq += 1) {
      const stored = await manager.streams.getMessage(MAIN_STREAM, { seq });
      const msgId = stored?.header.get("Nats-Msg-Id");
      if (msgId !== undefined && msgId !== "") {
        ids.push(msgId);
      }
    }
    return ids;
  } finally {
    await connection.close();
  }
}

describe("a broker outage", () => {
  it("never makes a row FAILED, however many ticks it lasts; once the broker is back every row is published in order per aggregate", async () => {
    const base = Date.now();
    const aggregates = [crypto.randomUUID(), crypto.randomUUID()];
    const rows = [0, 1, 2].flatMap((index) =>
      aggregates.map((aggregateId, which) => ({
        id: crypto.randomUUID(),
        aggregateType: "order",
        aggregateId,
        eventType: ["order.placed", "order.confirmed", "order.expired"][index] ?? "order.placed",
        payload: { index },
        createdAt: new Date(base + index * 2 + which),
      })),
    );
    await prisma.outboxEvent.createMany({ data: rows });
    const relay = createOutboxRelay({ bus, prisma, maxPermanentFailures: CAP });

    await standIn.setMode("closed");
    for (let tick = 0; tick < CAP + 3; tick += 1) {
      expect(await relay.tick()).toBe(0);
    }

    const during = await prisma.outboxEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(during.map((row) => row.status)).toEqual(rows.map(() => "PENDING"));
    expect(during.every((row) => row.permanentFailures === 0 && row.failedAt === null)).toBe(true);
    // The first row of each aggregate was retried on every tick; transient failures count only here.
    expect(during.filter((row) => row.attempts === CAP + 3)).toHaveLength(aggregates.length);
    for (const row of during) {
      expect(await readOutboxHistory(prisma, "booking", row.id)).toEqual([]);
    }

    await standIn.setMode("forward");
    await expect
      .poll(
        async () => {
          await relay.tick();
          return prisma.outboxEvent.count({ where: { status: "PUBLISHED" } });
        },
        { timeout: 20_000, interval: 100 },
      )
      .toBe(rows.length);

    expect(await prisma.outboxEvent.count({ where: { status: "FAILED" } })).toBe(0);
    const stored = await storedMsgIds();
    for (const aggregateId of aggregates) {
      const expected: string[] = rows
        .filter((row) => row.aggregateId === aggregateId)
        .map((row) => row.id);
      expect(stored.filter((id) => expected.includes(id))).toEqual(expected);
    }
  });
});
