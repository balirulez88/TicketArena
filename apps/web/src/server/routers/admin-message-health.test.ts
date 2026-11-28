import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPaymentSagaHandler } from "@ticketarena/booking";
import { testClients } from "@ticketarena/booking/testing";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import { createRedisQueueStore } from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { adminCaller } from "../testing/admin-caller";
import type { TRPCContext } from "../trpc";
import { createWorkerHealthReader } from "../worker-health";

// The snapshot's message health (spec: Admin dashboard): outbox lag per service from Postgres,
// the NATS figures from the worker's /health, and refund_pending_age_max. A database of its own,
// with no catalog, so every outbox row and obligation is this file's.
const database = setupTestDatabase();
const redis = setupTestRedis();
const { db } = testClients(database);
const redisClient = createClient({ url: redis.url });

const NOW = new Date("2027-03-01T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

/** The worker's /health as the network boundary: a real HTTP server answering a fixed body. */
let workerBody: unknown;
let workerStatus = 200;
let workerServer: Server;
let workerUrl: string;

beforeAll(async () => {
  await redisClient.connect();
  workerServer = createServer((_request, response) => {
    response.writeHead(workerStatus, { "content-type": "application/json" });
    response.end(JSON.stringify(workerBody));
  });
  await new Promise<void>((resolve) => workerServer.listen(0, "127.0.0.1", resolve));
  workerUrl = `http://127.0.0.1:${(workerServer.address() as AddressInfo).port}/health`;
});

afterAll(async () => {
  redisClient.destroy();
  await new Promise((resolve) => workerServer.close(resolve));
});

beforeEach(async () => {
  workerStatus = 200;
  await db().outboxEvent.deleteMany();
  await db().paymentOutboxEvent.deleteMany();
  await db().notificationOutboxEvent.deleteMany();
  await db().orphanRefundObligation.deleteMany();
});

const DELIVERY = {
  consumers: {
    payment: { lag: 4, pendingAcks: 2, redeliveries: 1 },
    notification: null,
  },
  dlq: { size: 3, oldestAgeMs: 90_000 },
};

function snapshotCaller(overrides: Partial<TRPCContext> = {}) {
  return adminCaller(db, NOW, {
    queueStore: async () => createRedisQueueStore(redisClient, { prefix: redis.prefix }),
    workerHealth: () => createWorkerHealthReader({ url: workerUrl }),
    ...overrides,
  });
}

function outboxRow(createdAt: Date, status: "PENDING" | "PUBLISHED" = "PENDING") {
  const id = randomUUID();
  return {
    id,
    aggregateType: "order",
    aggregateId: id,
    eventType: "order.placed",
    payload: { id },
    status,
    createdAt,
  };
}

describe("admin.snapshot message health", () => {
  test("reports outbox lag per service, the worker's consumer and DLQ figures, and refund_pending_age_max", async () => {
    workerBody = { status: "ok", redis: "ok", outbox: { alert: false }, delivery: DELIVERY };
    await db().outboxEvent.createMany({
      data: [outboxRow(ago(30)), outboxRow(ago(10)), outboxRow(ago(300), "PUBLISHED")],
    });
    await db().paymentOutboxEvent.create({ data: outboxRow(ago(5)) });
    // An orphan refund obligation recorded two minutes ago.
    const saga = createPaymentSagaHandler({ clock: { now: () => ago(120) }, newId: randomUUID });
    const paymentId = randomUUID();
    const orderId = randomUUID();
    await db().$transaction((tx) =>
      saga(
        tx,
        {
          data: JSON.stringify({
            id: randomUUID(),
            type: "payment.succeeded",
            version: 1,
            occurredAt: ago(120).toISOString(),
            correlationId: randomUUID(),
            causationId: randomUUID(),
            orderId,
            payload: {
              paymentId,
              orderId,
              attemptNo: 1,
              amount: 1000,
              currency: "EUR",
              capturedAt: ago(120).toISOString(),
            },
          }),
        },
        { emit: async () => undefined },
      ),
    );

    const snapshot = await snapshotCaller().admin.snapshot();

    expect(snapshot.messageHealth).toEqual({
      outboxLagMs: { booking: 30_000, payment: 5_000, notification: 0 },
      delivery: DELIVERY,
    });
    expect(snapshot.refundPendingAgeMaxMs).toBe(120_000);
  });

  test("reports the NATS figures as null, and the rest, when the worker has none", async () => {
    workerBody = { status: "ok", delivery: "unavailable" };

    const snapshot = await snapshotCaller().admin.snapshot();

    expect(snapshot.messageHealth).toEqual({
      outboxLagMs: { booking: 0, payment: 0, notification: 0 },
      delivery: null,
    });
    expect(snapshot.refundPendingAgeMaxMs).toBe(0);
  });

  test("reports the NATS figures as null when the worker fails, answers garbage or is not configured", async () => {
    workerStatus = 503;
    workerBody = { status: "down" };
    expect((await snapshotCaller().admin.snapshot()).messageHealth.delivery).toBeNull();

    workerStatus = 200;
    workerBody = { status: "ok", delivery: { consumers: "many" } };
    expect((await snapshotCaller().admin.snapshot()).messageHealth.delivery).toBeNull();

    const unconfigured = snapshotCaller({
      workerHealth: () => {
        throw new Error("Invalid worker health environment: WORKER_HEALTH_URL");
      },
    });
    expect((await unconfigured.admin.snapshot()).messageHealth.delivery).toBeNull();
  });
});
