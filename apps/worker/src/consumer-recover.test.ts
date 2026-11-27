import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import {
  type ConsumerAdmin,
  connectJetStreamConsumerAdmin,
  connectJetStreamMessageBus,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRecoverCommand, recoverServiceConsumer } from "./consumer-recover.js";
import { createServiceConsumers } from "./consumers.js";

// The operator's `consumer:recover` command (runbook: docs/messaging/consumer-recovery.md): it
// recreates one of the worker's durable consumers by name, with that consumer's filter and service.
const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;
let admin: ConsumerAdmin;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  const options = {
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  };
  bus = await connectJetStreamMessageBus(options);
  await bus.ensureTopology();
  admin = await connectJetStreamConsumerAdmin(options);
});

afterAll(async () => {
  await admin.close();
  await bus.close();
  await prisma.$disconnect();
});

const consumers = () =>
  createServiceConsumers({
    prisma,
    clock: { now: () => new Date(), sleep: async () => undefined },
    random: { next: () => 0 },
    newId: randomUUID,
  });

describe("recoverServiceConsumer", () => {
  it("recreates a worker consumer by name at the first message its service has not processed", async () => {
    const processedId = randomUUID();
    const processed = await bus.publish({
      subject: "ta.order.placed",
      data: "{}",
      msgId: processedId,
    });
    const unprocessedId = randomUUID();
    const unprocessed = await bus.publish({
      subject: "ta.order.placed",
      data: "{}",
      msgId: unprocessedId,
    });
    // The payment consumer records in the payment schema, so only a row there counts.
    await prisma.paymentProcessedMessage.create({
      data: { consumer: "payment", messageId: processedId, streamSeq: BigInt(processed.streamSeq) },
    });
    await prisma.processedMessage.create({
      data: {
        consumer: "payment",
        messageId: unprocessedId,
        streamSeq: BigInt(unprocessed.streamSeq),
      },
    });

    const report = await recoverServiceConsumer({
      admin,
      prisma,
      consumers: consumers(),
      consumer: "payment",
      ignoreAckFloor: false,
      now: new Date(),
    });

    expect(report).toEqual({
      rule: "checkpoint",
      startSeq: unprocessed.streamSeq,
      service: "payment",
      filterSubject: "ta.order.placed",
    });
    expect(await admin.consumerState("payment")).toMatchObject({
      filterSubject: "ta.order.placed",
    });
  });

  it("refuses an unknown consumer name, naming the worker's consumers", async () => {
    await expect(
      recoverServiceConsumer({
        admin,
        prisma,
        consumers: consumers(),
        consumer: "nope",
        ignoreAckFloor: false,
        now: new Date(),
      }),
    ).rejects.toThrow(/unknown consumer "nope"[\s\S]*payment[\s\S]*notification-refunded/);
  });
});

describe("parseRecoverCommand", () => {
  const env = { DATABASE_URL: "postgresql://u:p@localhost:5432/db", NATS_URL: "nats://n:4222" };

  it("names every missing or invalid argument and variable", () => {
    expect(() => parseRecoverCommand([], {})).toThrow(/consumer[\s\S]*DATABASE_URL[\s\S]*NATS_URL/);
  });

  it("returns the validated command; the ack floor is used unless --ignore-ack-floor is given", () => {
    expect(parseRecoverCommand(["--consumer", "payment"], env)).toEqual({
      databaseUrl: env.DATABASE_URL,
      natsUrl: env.NATS_URL,
      consumer: "payment",
      ignoreAckFloor: false,
    });
    expect(
      parseRecoverCommand(["--consumer", "payment", "--ignore-ack-floor"], {
        ...env,
        NATS_TOKEN: "secret",
      }),
    ).toEqual({
      databaseUrl: env.DATABASE_URL,
      natsUrl: env.NATS_URL,
      natsToken: "secret",
      consumer: "payment",
      ignoreAckFloor: true,
    });
  });
});
