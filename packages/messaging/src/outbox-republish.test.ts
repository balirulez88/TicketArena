import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
  OutboxRepublishRefused,
  readOutboxHistory,
  republishOutboxEvents,
} from "./index.js";

// The outbox re-publish of ADR 0011 consumer recovery ("beyond stream retention"), against real
// Postgres and NATS: PUBLISHED rows in a time range go back to PENDING under their original ids.
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

beforeEach(async () => {
  await prisma.paymentOutboxEvent.deleteMany();
  await prisma.paymentProcessedMessage.deleteMany();
});

const FROM = new Date("2027-04-01T00:00:00.000Z");
const TO = new Date("2027-04-02T00:00:00.000Z");
const AT = new Date("2027-04-10T09:00:00.000Z");

function row(
  status: "PENDING" | "PUBLISHED" | "FAILED",
  publishedAt: Date | undefined,
  extra: { eventType?: string; permanentFailures?: number } = {},
) {
  return {
    id: crypto.randomUUID(),
    aggregateType: "payment",
    aggregateId: crypto.randomUUID(),
    eventType: extra.eventType ?? "payment.succeeded",
    payload: { hello: "world" },
    status,
    attempts: 3,
    permanentFailures: extra.permanentFailures ?? 0,
    createdAt: new Date(FROM.getTime() - 60_000),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(status === "FAILED" ? { failedAt: FROM } : {}),
  };
}

const input = {
  service: "payment" as const,
  publishedFrom: FROM,
  publishedTo: TO,
  operator: "alice",
  reason: "NATS volume lost",
  at: AT,
};

describe("republishOutboxEvents", () => {
  it("moves the PUBLISHED rows published in [from, to) back to PENDING and records each in the history", async () => {
    const inRange = row("PUBLISHED", FROM, { permanentFailures: 2 });
    const atEnd = row("PUBLISHED", TO);
    const before = row("PUBLISHED", new Date(FROM.getTime() - 1));
    await prisma.paymentOutboxEvent.createMany({ data: [inRange, atEnd, before] });

    const moved = await republishOutboxEvents(prisma, input);

    expect(moved).toBe(1);
    expect(
      await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: inRange.id } }),
    ).toMatchObject({
      status: "PENDING",
      publishedAt: null,
      permanentFailures: 0,
      attempts: 3,
      payload: inRange.payload,
    });
    expect(await readOutboxHistory(prisma, "payment", inRange.id)).toEqual([
      {
        kind: "STATUS_CHANGED",
        fromStatus: "PUBLISHED",
        toStatus: "PENDING",
        attempt: 3,
        error: null,
        operator: "alice",
        reason: "NATS volume lost",
        at: AT,
      },
    ]);
    for (const untouched of [atEnd, before]) {
      expect(
        (await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: untouched.id } })).status,
      ).toBe("PUBLISHED");
    }
  });

  it("never touches a FAILED or a PENDING row, so a FAILED row leaves only by the audited requeue", async () => {
    const failed = row("FAILED", undefined);
    const pending = row("PENDING", undefined);
    await prisma.paymentOutboxEvent.createMany({ data: [failed, pending] });

    expect(await republishOutboxEvents(prisma, input)).toBe(0);

    expect(
      await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: failed.id } }),
    ).toMatchObject({ status: "FAILED", failedAt: FROM });
    expect(await readOutboxHistory(prisma, "payment", failed.id)).toEqual([]);
    expect(await readOutboxHistory(prisma, "payment", pending.id)).toEqual([]);
  });

  it("refuses an empty range or a missing operator or reason, changing nothing", async () => {
    const inRange = row("PUBLISHED", FROM);
    await prisma.paymentOutboxEvent.create({ data: inRange });

    await expect(
      republishOutboxEvents(prisma, { ...input, publishedTo: FROM }),
    ).rejects.toBeInstanceOf(OutboxRepublishRefused);
    await expect(republishOutboxEvents(prisma, { ...input, operator: " " })).rejects.toThrow(
      /operator and a reason/,
    );

    expect(
      (await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: inRange.id } })).status,
    ).toBe("PUBLISHED");
  });

  it("after broker data loss, re-publishes under the original id and a consumer that processed it dedupes it", async () => {
    const subject = "payment.republished";
    const event = { ...row("PENDING", undefined, { eventType: subject }) };
    await prisma.paymentOutboxEvent.create({ data: event });
    const relay = createOutboxRelay({ bus, prisma, service: "payment" });
    await relay.tick();
    const handled: string[] = [];
    const runnerOptions = {
      bus,
      prisma,
      service: "payment" as const,
      consumer: "republish-consumer",
      filterSubject: `ta.${subject}`,
      handler: async (_tx: unknown, message: { msgId: string | undefined }) => {
        handled.push(message.msgId ?? "");
        return undefined;
      },
    };
    await (await createConsumerRunner(runnerOptions)).pollOnce();
    expect(handled).toEqual([event.id]);
    const published = await prisma.paymentOutboxEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    await loseTheMainStream();
    await bus.ensureTopology();

    await republishOutboxEvents(prisma, {
      ...input,
      publishedFrom: published.publishedAt ?? FROM,
      publishedTo: new Date(Date.now() + 60_000),
    });
    await relay.tick();

    const seen: (string | undefined)[] = [];
    const replay = await createConsumerRunner({
      ...runnerOptions,
      beforeTransaction: async (message) => {
        seen.push(message.msgId);
      },
    });
    await replay.pollOnce();
    expect(seen).toEqual([event.id]);
    expect(handled).toEqual([event.id]);
    expect(
      (await prisma.paymentOutboxEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
    ).toBe("PUBLISHED");
  });
});

/** The single-node disk loss of ADR 0011: the stream, its messages and its consumers are gone. */
async function loseTheMainStream(): Promise<void> {
  const connection = await connect({ servers: nats.url });
  try {
    await (await jetstreamManager(connection)).streams.delete(`${nats.streamPrefix}TICKETARENA`);
  } finally {
    await connection.close();
  }
}
