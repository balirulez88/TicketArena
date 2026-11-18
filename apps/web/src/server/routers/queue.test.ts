import { randomUUID } from "node:crypto";
import { silentLogger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import { createRedisQueueStore, type Random } from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createCaller } from "./_app";

const database = setupTestDatabase();
const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const SEEDED_AT = new Date("2027-03-01T12:00:00.000Z");

beforeAll(async () => {
  await redisClient.connect();
  await seedCatalog(db(), SEEDED_AT);
});

afterAll(async () => {
  redisClient.destroy();
  await prisma?.$disconnect();
});

// One queue namespace per test, so the seeded event can be reused without sharing positions.
let queuePrefix = "";

function guest(): Principal {
  return { kind: "guest", sessionId: randomUUID().replaceAll("-", "") };
}

function caller(principal: Principal, now: Date, random: Random = { next: () => 0.5 }) {
  return createCaller({
    now: () => now,
    principal,
    db: db(),
    logger: silentLogger,
    metrics: () => ({ increment: async () => undefined }),
    queueStore: async () =>
      createRedisQueueStore(redisClient, { prefix: `${redis.prefix}${queuePrefix}` }),
    random,
  });
}

async function scheduledEvent() {
  queuePrefix = `${randomUUID()}:`;
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  return {
    eventId: event.id,
    beforeOnSale: new Date(event.onSaleAt.getTime() - 60_000),
    afterOnSale: new Date(event.onSaleAt.getTime() + 60_000),
    outsideWindow: new Date(event.queueOpensAt.getTime() - 60_000),
  };
}

describe("queue.join", () => {
  test("in the queue window returns the position and an ETA", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    await caller(guest(), afterOnSale).queue.join({ eventId });

    const result = await caller(guest(), afterOnSale).queue.join({ eventId });

    expect(result).toEqual({ status: "QUEUED", position: 2, etaSeconds: expect.any(Number) });
  });

  test("orders pre-queue joins by the injected randomness ahead of later joins", async () => {
    const { eventId, beforeOnSale, afterOnSale } = await scheduledEvent();
    const [late, high, low] = [guest(), guest(), guest()];
    await caller(late, afterOnSale).queue.join({ eventId });
    await caller(high, beforeOnSale, { next: () => 0.8 }).queue.join({ eventId });
    await caller(low, beforeOnSale, { next: () => 0.2 }).queue.join({ eventId });

    const statuses = await Promise.all(
      [low, high, late].map((principal) =>
        caller(principal, afterOnSale).queue.status({ eventId }),
      ),
    );

    expect(statuses).toMatchObject([{ position: 1 }, { position: 2 }, { position: 3 }]);
  });

  test("a re-join keeps the position", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    await caller(alice, afterOnSale).queue.join({ eventId });
    await caller(guest(), afterOnSale).queue.join({ eventId });

    expect(await caller(alice, afterOnSale).queue.join({ eventId })).toMatchObject({
      position: 1,
    });
  });

  test("outside the queue window reports immediate admission eligibility", async () => {
    const { eventId, outsideWindow } = await scheduledEvent();

    expect(await caller(guest(), outsideWindow).queue.join({ eventId })).toEqual({
      status: "ADMISSIBLE",
    });
  });

  test("an unknown event is NOT_FOUND", async () => {
    await expect(
      caller(guest(), SEEDED_AT).queue.join({ eventId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a malformed event id is BAD_REQUEST naming eventId", async () => {
    await expect(caller(guest(), SEEDED_AT).queue.join({ eventId: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("eventId"),
    });
  });
});

describe("queue.status and queue.leave", () => {
  test("status reports the position; leave removes the caller and moves the next buyer up", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const [alice, bob] = [guest(), guest()];
    await caller(alice, afterOnSale).queue.join({ eventId });
    await caller(bob, afterOnSale).queue.join({ eventId });

    expect(await caller(bob, afterOnSale).queue.status({ eventId })).toEqual({
      status: "QUEUED",
      position: 2,
      etaSeconds: expect.any(Number),
    });

    expect(await caller(alice, afterOnSale).queue.leave({ eventId })).toEqual({ left: true });

    expect(await caller(alice, afterOnSale).queue.status({ eventId })).toEqual({
      status: "NOT_QUEUED",
    });
    expect(await caller(bob, afterOnSale).queue.status({ eventId })).toMatchObject({
      position: 1,
    });
  });

  test("leave rejects a malformed event id naming eventId", async () => {
    await expect(caller(guest(), SEEDED_AT).queue.leave({ eventId: "x" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("eventId"),
    });
  });
});
