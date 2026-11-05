import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type BookingMetrics,
  type Buyer,
  createBookingService,
  createRedisBookingMetrics,
} from "./index";

const database = setupTestDatabase();
const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });
let prisma: PrismaClient | undefined;
let racePool: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const CONCURRENT_BUYERS = 100;
// Sized for 100 callers queueing on one row lock: waiters must outlast the whole queue, so the
// split is SEAT_UNAVAILABLE rather than BOOKING_BUSY.
const RACE_WAIT_MS = 60_000;

/** A separate client so seeding and assertions never compete with the race for connections. */
function raceDb(): PrismaClient {
  racePool ??= createPrismaClient({
    connectionString: database.url,
    driver: "pg",
    poolMax: 20,
    acquireTimeoutMs: RACE_WAIT_MS,
    transaction: { maxWaitMs: RACE_WAIT_MS, timeoutMs: RACE_WAIT_MS },
  });
  return racePool;
}

function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
  await redisClient.connect();
});

afterAll(async () => {
  redisClient.destroy();
  await racePool?.$disconnect();
  await prisma?.$disconnect();
});

async function freeSeats(count: number) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seats = await db().seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
    take: count,
  });
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

/** Each test counts under its own namespace so tests sharing one event cannot see each other. */
function counters(namespace: string, eventId: string) {
  return redisClient.hGetAll(`${namespace}booking:metrics:${eventId}`);
}

function serviceWith(metrics: BookingMetrics, client: PrismaClient = db()) {
  return createBookingService({
    db: client,
    clock: { now: () => NOW },
    newId: randomUUID,
    metrics,
  });
}

describe("hot-seat race (AT-01)", () => {
  test("100 concurrent holds on one free seat: exactly one wins, the rest are refused cleanly", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const namespace = `${redis.prefix}race:`;
    const service = serviceWith(createRedisBookingMetrics(redisClient, namespace), raceDb());

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_BUYERS }, (_, n) =>
        service.holdSeats(buyer(n + 1), eventId, seatIds).then(
          () => "held",
          (error: unknown) =>
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "OTHER",
        ),
      ),
    );

    const split: Record<string, number> = {};
    for (const outcome of outcomes) {
      split[outcome] = (split[outcome] ?? 0) + 1;
    }
    process.stdout.write(`AT-01 split ${JSON.stringify(split)}\n`);
    expect(split).toEqual({ held: 1, SEAT_UNAVAILABLE: CONCURRENT_BUYERS - 1 });
    expect(
      await db().hold.count({
        where: { status: "HELD", seats: { some: { id: seatIds[0] ?? "" } } },
      }),
    ).toBe(1);

    await expect.poll(() => counters(namespace, eventId)).toMatchObject({ hold_ok: "1" });
    const counted = await counters(namespace, eventId);
    expect(Number(counted["seat_unavailable"] ?? 0) + Number(counted["race_lost"] ?? 0)).toBe(
      CONCURRENT_BUYERS - 1,
    );
  });
});

describe("booking metrics", () => {
  test("a visibly sold seat counts seat_unavailable, not race_lost", async () => {
    const { eventId, seatIds } = await freeSeats(2);
    const namespace = `${redis.prefix}sold:`;
    await db().seat.update({ where: { id: seatIds[1] ?? "" }, data: { status: "SOLD" } });
    const service = serviceWith(createRedisBookingMetrics(redisClient, namespace));
    await expect(service.holdSeats(buyer(500), eventId, [seatIds[1] ?? ""])).rejects.toMatchObject({
      code: "SEAT_UNAVAILABLE",
    });
    await expect.poll(() => counters(namespace, eventId)).toMatchObject({ seat_unavailable: "1" });
    expect((await counters(namespace, eventId))["race_lost"]).toBeUndefined();
  });

  test("a Redis failure is logged and never fails the booking", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const warnings: unknown[] = [];
    const logger = {
      info: () => undefined,
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => undefined,
      child: () => logger,
    };
    const service = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      logger,
      metrics: { increment: () => Promise.reject(new Error("redis down")) },
    });
    await expect(service.holdSeats(buyer(600), eventId, seatIds)).resolves.toMatchObject({
      status: "HELD",
    });
    await expect.poll(() => warnings.length).toBeGreaterThan(0);
  });
});
