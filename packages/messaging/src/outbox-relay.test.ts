import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createOutboxRelay,
  DEFAULT_RELAY_BATCH_SIZE,
  DEFAULT_RELAY_INTERVAL_MS,
  type MessageBus,
  type PublishInput,
} from "./index.js";

const database = setupTestDatabase();
const nats = setupTestNats();
const MAIN_STREAM = `${nats.streamPrefix}TICKETARENA`;

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

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
  const connection = await connect({ servers: nats.url });
  try {
    await (await jetstreamManager(connection)).streams.purge(MAIN_STREAM);
  } finally {
    await connection.close();
  }
});

async function seedPending(count: number, eventType = "order.placed"): Promise<string[]> {
  const base = Date.now();
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  await prisma.outboxEvent.createMany({
    data: ids.map((id, index) => ({
      id,
      aggregateType: "order",
      aggregateId: crypto.randomUUID(),
      eventType,
      payload: { id, type: eventType },
      createdAt: new Date(base + index),
    })),
  });
  return ids;
}

async function streamMessages(): Promise<{ msgId: string | undefined; subject: string }[]> {
  const connection = await connect({ servers: nats.url });
  try {
    const manager = await jetstreamManager(connection);
    const info = await manager.streams.info(MAIN_STREAM);
    const found: { msgId: string | undefined; subject: string }[] = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq += 1) {
      const stored = await manager.streams.getMessage(MAIN_STREAM, { seq });
      if (stored !== null) {
        found.push({
          msgId: stored.header.get("Nats-Msg-Id") || undefined,
          subject: stored.subject,
        });
      }
    }
    return found;
  } finally {
    await connection.close();
  }
}

describe("outbox relay", () => {
  it("defaults to a 250 ms polling interval and a batch of 100", () => {
    expect(DEFAULT_RELAY_INTERVAL_MS).toBe(250);
    expect(DEFAULT_RELAY_BATCH_SIZE).toBe(100);
  });

  it("publishes with Nats-Msg-Id = outbox id on ta.<eventType> and marks the rows PUBLISHED", async () => {
    const [id] = await seedPending(1);
    const relay = createOutboxRelay({ bus, prisma });

    expect(await relay.tick()).toBe(1);

    expect(await streamMessages()).toEqual([
      { msgId: id, subject: `${nats.subjectPrefix}.ta.order.placed` },
    ]);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id ?? "" } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it("publishes exactly one batch of 100 per tick", async () => {
    await seedPending(DEFAULT_RELAY_BATCH_SIZE + 20);
    const relay = createOutboxRelay({ bus, prisma });

    expect(await relay.tick()).toBe(100);

    expect(await streamMessages()).toHaveLength(100);
    expect(await prisma.outboxEvent.count({ where: { status: "PENDING" } })).toBe(20);
    expect(await relay.tick()).toBe(20);
    expect(await relay.tick()).toBe(0);
  });

  it("counts a failed publish on the row and leaves it PENDING for the next tick", async () => {
    const [id] = await seedPending(1);
    const failingBus: MessageBus = {
      ...bus,
      publish: async () => {
        throw new Error("stream full");
      },
    };

    expect(await createOutboxRelay({ bus: failingBus, prisma }).tick()).toBe(0);

    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: id ?? "" } });
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastError: "stream full" });
    expect(await createOutboxRelay({ bus, prisma }).tick()).toBe(1);
  });

  it("never publishes rows from a rolled-back transaction (AT-26)", async () => {
    const [committed] = await seedPending(1);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.outboxEvent.create({
          data: {
            id: crypto.randomUUID(),
            aggregateType: "order",
            aggregateId: "rolled-back",
            eventType: "order.placed",
            payload: {},
          },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");

    await createOutboxRelay({ bus, prisma }).tick();

    expect(await streamMessages()).toEqual([
      { msgId: committed, subject: `${nats.subjectPrefix}.ta.order.placed` },
    ]);
  });

  it("lets two concurrent relays split pending rows without publishing any twice (SKIP LOCKED)", async () => {
    const ids = await seedPending(6);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHasClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => {
      firstHasClaimed = resolve;
    });
    const firstPublished: string[] = [];
    const secondPublished: string[] = [];
    const heldBus: MessageBus = {
      ...bus,
      publish: async (input: PublishInput) => {
        firstHasClaimed();
        await gate;
        firstPublished.push(input.msgId);
        return bus.publish(input);
      },
    };
    const recordingBus: MessageBus = {
      ...bus,
      publish: async (input: PublishInput) => {
        secondPublished.push(input.msgId);
        return bus.publish(input);
      },
    };
    const first = createOutboxRelay({ bus: heldBus, prisma, batchSize: 4 });
    const second = createOutboxRelay({ bus: recordingBus, prisma, batchSize: 4 });

    const firstTick = first.tick();
    await claimed;
    // The first relay's transaction is open and its 4 rows are locked.
    const secondCount = await second.tick();
    release();
    const firstCount = await firstTick;

    expect(firstPublished).toEqual(ids.slice(0, 4));
    expect(secondPublished).toEqual(ids.slice(4));
    expect([firstCount, secondCount]).toEqual([4, 2]);
    const stored = (await streamMessages()).map((message) => message.msgId).sort();
    expect(stored).toEqual([...ids].sort());
  });

  it("never lets a second relay publish a later row of an aggregate whose earlier row is claimed elsewhere", async () => {
    const aggregateId = crypto.randomUUID();
    const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
    const base = Date.now();
    await prisma.outboxEvent.createMany({
      data: [first, second].map((id, index) => ({
        id,
        aggregateType: "order",
        aggregateId,
        eventType: index === 0 ? "order.placed" : "order.confirmed",
        payload: { id },
        createdAt: new Date(base + index),
      })),
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hasClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => {
      hasClaimed = resolve;
    });
    const failingBus: MessageBus = {
      ...bus,
      publish: async () => {
        hasClaimed();
        await gate;
        throw new Error("stream full");
      },
    };

    const failingTick = createOutboxRelay({ bus: failingBus, prisma }).tick();
    await claimed;
    expect(await createOutboxRelay({ bus, prisma }).tick()).toBe(0);
    release();
    expect(await failingTick).toBe(0);

    expect(await createOutboxRelay({ bus, prisma }).tick()).toBe(1);
    expect(await createOutboxRelay({ bus, prisma }).tick()).toBe(1);
    expect((await streamMessages()).map((message) => message.msgId)).toEqual([first, second]);
  });
});
