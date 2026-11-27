import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pruneRetention, RETENTION_MS, readOutboxHistory } from "./index.js";

// The 14-day retention job (ADR 0011 retention invariant) against real Postgres.
const database = setupTestDatabase();

let prisma: PrismaClient;

beforeAll(() => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
  await prisma.paymentOutboxEvent.deleteMany();
  await prisma.notificationOutboxEvent.deleteMany();
  await prisma.processedMessage.deleteMany();
  await prisma.paymentProcessedMessage.deleteMany();
  await prisma.notificationProcessedMessage.deleteMany();
  await prisma.orphanRefundObligation.deleteMany();
});

const NOW = new Date("2027-04-01T12:00:00.000Z");
const OLD = new Date(NOW.getTime() - RETENTION_MS - 60_000);
const RECENT = new Date(NOW.getTime() - RETENTION_MS + 60_000);

function outboxRow(overrides: {
  status: "PENDING" | "PUBLISHED" | "FAILED";
  createdAt: Date;
  publishedAt?: Date;
  failedAt?: Date;
  eventType?: string;
  aggregateId?: string;
  payload?: object;
}) {
  return {
    id: crypto.randomUUID(),
    aggregateType: "order",
    aggregateId: overrides.aggregateId ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? "order.placed",
    payload: overrides.payload ?? {},
    status: overrides.status,
    createdAt: overrides.createdAt,
    ...(overrides.publishedAt === undefined ? {} : { publishedAt: overrides.publishedAt }),
    ...(overrides.failedAt === undefined ? {} : { failedAt: overrides.failedAt }),
  };
}

describe("pruneRetention", () => {
  it("deletes every service's PUBLISHED outbox rows published more than 14 days ago and keeps the rest", async () => {
    const old = outboxRow({ status: "PUBLISHED", createdAt: OLD, publishedAt: OLD });
    const recent = outboxRow({ status: "PUBLISHED", createdAt: OLD, publishedAt: RECENT });
    // Waiting since long ago and never published: deleting it would lose the event.
    const pending = outboxRow({ status: "PENDING", createdAt: OLD });
    await prisma.outboxEvent.createMany({ data: [old, recent, pending] });
    const paymentOld = outboxRow({ status: "PUBLISHED", createdAt: OLD, publishedAt: OLD });
    await prisma.paymentOutboxEvent.create({ data: paymentOld });
    const notificationOld = outboxRow({ status: "PUBLISHED", createdAt: OLD, publishedAt: OLD });
    await prisma.notificationOutboxEvent.create({ data: notificationOld });

    const pruned = await pruneRetention({ prisma, now: NOW });

    expect((await prisma.outboxEvent.findMany()).map((row) => row.id).sort()).toEqual(
      [recent.id, pending.id].sort(),
    );
    expect(await prisma.paymentOutboxEvent.count()).toBe(0);
    expect(await prisma.notificationOutboxEvent.count()).toBe(0);
    expect(pruned).toMatchObject({
      booking: { outbox: 1 },
      payment: { outbox: 1 },
      notification: { outbox: 1 },
    });
  });

  it("never deletes a FAILED row, however old, nor a row with history, and keeps their history (ADR 0022)", async () => {
    const failed = outboxRow({ status: "FAILED", createdAt: OLD, failedAt: OLD });
    const requeuedThenPublished = outboxRow({
      status: "PUBLISHED",
      createdAt: OLD,
      publishedAt: OLD,
    });
    await prisma.paymentOutboxEvent.createMany({ data: [failed, requeuedThenPublished] });
    for (const id of [failed.id, requeuedThenPublished.id]) {
      await prisma.paymentOutboxEventHistory.create({
        data: {
          outboxId: id,
          kind: "STATUS_CHANGED",
          fromStatus: "PENDING",
          toStatus: "FAILED",
          attempt: 5,
          error: "no stream",
          at: OLD,
        },
      });
    }

    await pruneRetention({ prisma, now: NOW });

    expect(await prisma.paymentOutboxEvent.count()).toBe(2);
    expect(await readOutboxHistory(prisma, "payment", failed.id)).toHaveLength(1);
    expect(await readOutboxHistory(prisma, "payment", requeuedThenPublished.id)).toHaveLength(1);
  });

  it("deletes every service's processed_messages rows older than 14 days and keeps newer ones", async () => {
    const row = (processedAt: Date) => ({
      consumer: "c",
      messageId: crypto.randomUUID(),
      streamSeq: 1n,
      processedAt,
    });
    const recent = row(RECENT);
    await prisma.processedMessage.createMany({ data: [row(OLD), recent] });
    await prisma.paymentProcessedMessage.createMany({ data: [row(OLD), row(RECENT)] });
    await prisma.notificationProcessedMessage.createMany({ data: [row(OLD), row(OLD)] });

    const pruned = await pruneRetention({ prisma, now: NOW, batchSize: 1 });

    expect((await prisma.processedMessage.findMany()).map((kept) => kept.messageId)).toEqual([
      recent.messageId,
    ]);
    expect(await prisma.paymentProcessedMessage.count()).toBe(1);
    expect(await prisma.notificationProcessedMessage.count()).toBe(0);
    expect(pruned).toMatchObject({
      booking: { processed: 1 },
      payment: { processed: 1 },
      notification: { processed: 2 },
    });
  });

  it("keeps an unknown_order refund request until its orphan refund obligation exists (refund cutover)", async () => {
    const request = (paymentId: string) =>
      outboxRow({
        status: "PUBLISHED",
        createdAt: OLD,
        publishedAt: OLD,
        eventType: "payment.refund_requested",
        aggregateId: paymentId,
        payload: {
          occurredAt: OLD.toISOString(),
          payload: { paymentId, orderId: crypto.randomUUID(), reason: "unknown_order" },
        },
      });
    const covered = crypto.randomUUID();
    const uncovered = crypto.randomUUID();
    const coveredRow = request(covered);
    const uncoveredRow = request(uncovered);
    await prisma.outboxEvent.createMany({ data: [coveredRow, uncoveredRow] });
    await prisma.orphanRefundObligation.create({
      data: {
        paymentId: covered,
        orderId: crypto.randomUUID(),
        amount: 100,
        currency: "EUR",
        capturedAt: OLD,
        status: "REFUND_REQUESTED",
        refundRequestedAt: OLD,
        correlationId: crypto.randomUUID(),
        refundLastRequestedAt: OLD,
      },
    });

    await pruneRetention({ prisma, now: NOW });

    expect((await prisma.outboxEvent.findMany()).map((row) => row.id)).toEqual([uncoveredRow.id]);
  });
});
