import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { deleteConsumer, setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConsumerAdmin,
  connectJetStreamConsumerAdmin,
  connectJetStreamMessageBus,
  createConsumerRunner,
  type HandlerOutcome,
  type MessageBus,
  RETENTION_MS,
  recreateConsumer,
} from "./index.js";

// ADR 0011 consumer recovery against real NATS and Postgres: the recreation applies the ack floor,
// then the processed_messages checkpoint scan, then a replay from the earliest retained message,
// and every rule delivers each unprocessed message while processed ones are deduped.
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

const LONG_DELAY_MS = 60_000;

interface Case {
  readonly consumer: string;
  readonly subject: string;
  /** Message ids in publish order, and their stream sequences. */
  readonly ids: string[];
  readonly seqs: number[];
}

/** Publishes `count` messages on a fresh subject for a fresh durable name. */
async function publishCase(count: number): Promise<Case> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const subject = `ta.order.recovery${suffix}`;
  const ids: string[] = [];
  const seqs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = crypto.randomUUID();
    const ack = await bus.publish({ subject, data: `m${index + 1}`, msgId: id });
    ids.push(id);
    seqs.push(ack.streamSeq);
  }
  return { consumer: `recovery-${suffix}`, subject, ids, seqs };
}

/**
 * Publishes `count` messages like `publishCase`, a few PubAcks in flight at a time: the local
 * broker fsyncs every write, so neither one round trip per message nor one large burst may hold it
 * long enough to starve other files' tight request timeouts. Sequences need not follow publish
 * order; the case maps each id to its own.
 */
const BULK_IN_FLIGHT = 10;

async function publishBulkCase(count: number): Promise<Case> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const subject = `ta.order.recovery${suffix}`;
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const seqs: number[] = [];
  for (let start = 0; start < count; start += BULK_IN_FLIGHT) {
    const acks = await Promise.all(
      ids
        .slice(start, start + BULK_IN_FLIGHT)
        .map((id, offset) => bus.publish({ subject, data: `m${start + offset + 1}`, msgId: id })),
    );
    seqs.push(...acks.map((ack) => ack.streamSeq));
  }
  return { consumer: `recovery-${suffix}`, subject, ids, seqs };
}

/**
 * A runner whose handler commits one side effect per message (an outbox row keyed by the message
 * id, so a second effect would be a unique violation, never silent) and records what it handled.
 * `beforeTransaction` runs on every delivery, duplicates included, so it records deliveries.
 */
async function runnerFor(
  current: Case,
  refuse: (data: string) => HandlerOutcome | undefined = () => undefined,
) {
  const delivered: string[] = [];
  const handled: string[] = [];
  const runner = await createConsumerRunner({
    bus,
    prisma,
    consumer: current.consumer,
    filterSubject: current.subject,
    retryDelayMs: () => LONG_DELAY_MS,
    beforeTransaction: async (message) => {
      delivered.push(message.data);
    },
    handler: async (tx, message) => {
      const refusal = refuse(message.data);
      if (refusal !== undefined) {
        return refusal;
      }
      handled.push(message.data);
      await tx.outboxEvent.create({
        data: {
          id: message.msgId ?? "",
          aggregateType: "recovery-test",
          aggregateId: current.consumer,
          eventType: "side.effect",
          payload: {},
        },
      });
      return undefined;
    },
  });
  return { runner, delivered, handled };
}

async function drain(runner: { pollOnce(): Promise<number> }): Promise<void> {
  while ((await runner.pollOnce()) > 0) {
    // Poll until a fetch comes back empty.
  }
}

async function sideEffects(current: Case): Promise<number> {
  return prisma.outboxEvent.count({ where: { aggregateId: current.consumer } });
}

async function processedIds(current: Case): Promise<string[]> {
  const rows = await prisma.processedMessage.findMany({ where: { consumer: current.consumer } });
  return rows.map((row) => row.messageId).sort();
}

describe("recreateConsumer", () => {
  it("AT-32: with an ack floor after out-of-order processing, resumes at ack_floor + 1 and delivers every unprocessed message", async () => {
    const current = await publishCase(5);
    // m2 and m4 fail and wait out a long delay, so m1, m3 and m5 are processed out of order and the
    // ack floor stays at m1 while m5, the highest processed, is far above it.
    const first = await runnerFor(current, (data) =>
      data === "m2" || data === "m4" ? { outcome: "retry", reason: "not yet" } : undefined,
    );
    await drain(first.runner);
    expect(first.handled).toEqual(["m1", "m3", "m5"]);
    await expect
      .poll(async () => (await admin.consumerState(current.consumer))?.ackFloorStreamSeq)
      .toBe(current.seqs[0]);

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(),
    });

    expect(result).toEqual({ rule: "ack_floor", startSeq: (current.seqs[0] ?? 0) + 1 });
    const second = await runnerFor(current);
    await drain(second.runner);
    expect(second.handled).toEqual(["m2", "m4"]);
    expect(second.delivered).toEqual(["m2", "m3", "m4", "m5"]);
    expect(await processedIds(current)).toEqual([...current.ids].sort());
    expect(await sideEffects(current)).toBe(5);
  });

  it("AT-33: processed {1, 2, 3, 5} and the consumer deleted, resumes at 4; 5 is redelivered and deduped", async () => {
    const current = await publishCase(5);
    const first = await runnerFor(current, (data) =>
      data === "m4" ? { outcome: "retry", reason: "not yet" } : undefined,
    );
    await drain(first.runner);
    expect(first.handled).toEqual(["m1", "m2", "m3", "m5"]);
    await deleteConsumer(nats.url, `${nats.streamPrefix}TICKETARENA`, current.consumer);

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(),
    });

    expect(result).toEqual({ rule: "checkpoint", startSeq: current.seqs[3] });
    const second = await runnerFor(current);
    await drain(second.runner);
    expect(second.delivered).toEqual(["m4", "m5"]);
    expect(second.handled).toEqual(["m4"]);
    expect(await sideEffects(current)).toBe(5);
  });

  it("AT-34: with no reliable checkpoint, replays from the earliest retained message with no duplicate side effects", async () => {
    const current = await publishCase(4);
    const first = await runnerFor(current, (data) =>
      data === "m3" ? { outcome: "retry", reason: "not yet" } : undefined,
    );
    await drain(first.runner);
    await deleteConsumer(nats.url, `${nats.streamPrefix}TICKETARENA`, current.consumer);
    const state = await admin.streamState();

    // Past the processed_messages retention, rows for the stream's first messages may be gone, so
    // the checkpoint cannot prove them processed (the clock is the injected boundary).
    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(Date.now() + RETENTION_MS + 60_000),
    });

    expect(result).toEqual({ rule: "earliest", startSeq: state.firstSeq });
    const second = await runnerFor(current);
    await drain(second.runner);
    expect(second.delivered).toEqual(["m1", "m2", "m3", "m4"]);
    expect(second.handled).toEqual(["m3"]);
    expect(await processedIds(current)).toEqual([...current.ids].sort());
    expect(await sideEffects(current)).toBe(4);
  });

  it("resumes at the dead-lettered message when the ack floor is ignored, so the fixed consumer applies it", async () => {
    const current = await publishCase(3);
    // m2 is poison: dead-lettered and terminated, which JetStream counts towards the ack floor.
    const first = await runnerFor(current, (data) =>
      data === "m2" ? { outcome: "poison", reason: "broken" } : undefined,
    );
    await drain(first.runner);
    await expect
      .poll(async () => (await admin.consumerState(current.consumer))?.ackFloorStreamSeq)
      .toBe(current.seqs[2]);

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(),
      ignoreAckFloor: true,
    });

    expect(result).toEqual({ rule: "checkpoint", startSeq: current.seqs[1] });
    const second = await runnerFor(current);
    await drain(second.runner);
    expect(second.handled).toEqual(["m2"]);
    expect(await sideEffects(current)).toBe(3);
  });

  it("scans past several pulls and id checks to the unprocessed message beyond the first batches", async () => {
    // 600 matching messages: more than one scan pull (256) and one id check (500). Only m551 is
    // unprocessed, so the start is right only if the scan really reaches it.
    const current = await publishBulkCase(600);
    const unprocessed = 550;
    await prisma.processedMessage.createMany({
      data: current.ids.flatMap((id, index) =>
        index === unprocessed
          ? []
          : [{ consumer: current.consumer, messageId: id, streamSeq: current.seqs[index] ?? 0 }],
      ),
    });

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(),
    });

    expect(result).toEqual({ rule: "checkpoint", startSeq: current.seqs[unprocessed] });
    const second = await runnerFor(current);
    await drain(second.runner);
    expect(second.handled).toEqual([`m${unprocessed + 1}`]);
  }, 60_000);

  it("resumes after the stream's end when the filter matches no retained message", async () => {
    // The scan's first pull is empty; only the stream confirms that nothing matches.
    await publishCase(1);
    const suffix = crypto.randomUUID().slice(0, 8);

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: `recovery-${suffix}`,
      filterSubject: `ta.order.none${suffix}`,
      now: new Date(),
    });

    const state = await admin.streamState();
    expect(result).toEqual({ rule: "checkpoint", startSeq: state.lastSeq + 1 });
  });

  it("does not use an ack floor recorded under another filter subject", async () => {
    const current = await publishCase(2);
    const first = await runnerFor(current);
    await drain(first.runner);
    await deleteConsumer(nats.url, `${nats.streamPrefix}TICKETARENA`, current.consumer);
    const other = await publishCase(1);
    await createConsumerRunner({
      bus,
      prisma,
      consumer: current.consumer,
      filterSubject: other.subject,
      handler: async () => undefined,
    });

    const result = await recreateConsumer({
      admin,
      prisma,
      consumer: current.consumer,
      filterSubject: current.subject,
      now: new Date(),
    });

    // Both of this subject's messages are processed, so the scan resumes after the stream's end.
    const state = await admin.streamState();
    expect(result).toEqual({ rule: "checkpoint", startSeq: state.lastSeq + 1 });
    expect((await admin.consumerState(current.consumer))?.filterSubject).toBe(current.subject);
  });
});
