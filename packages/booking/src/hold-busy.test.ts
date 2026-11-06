import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { POOL_ACQUIRE_TIMEOUT_MESSAGE } from "./booking-service";
import { type Buyer, createBookingService } from "./index";
import { backendPid, latch, waitUntilBlockedBy } from "./pg-blocking";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
let seedClient: PrismaClient | undefined;
let tight: PrismaClient | undefined;
let patient: PrismaClient | undefined;

function seeder(): PrismaClient {
  seedClient ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return seedClient;
}

/** Holds the client's only connection; resolves once the occupier's own statement has run. */
async function occupy(client: PrismaClient) {
  const occupied = latch();
  const gate = latch();
  const occupier = client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1`;
    occupied.open();
    await gate.promise;
  });
  await occupied.promise;
  return { release: gate.open, occupier };
}

function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(seeder(), NOW);
});

afterAll(async () => {
  await tight?.$disconnect();
  await patient?.$disconnect();
  await seedClient?.$disconnect();
});

describe("BOOKING_BUSY", () => {
  test("a hold that cannot get a connection or start its transaction in time is retryable BOOKING_BUSY", async () => {
    const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
    const seats = await seeder().seat.findMany({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
      take: 1,
    });
    const seatIds = seats.map((seat) => seat.id);
    const counted: string[] = [];
    // One connection and a short wait: concurrent callers queue behind the lock holder below.
    tight = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      poolMax: 1,
      acquireTimeoutMs: 200,
      transaction: { maxWaitMs: 200, timeoutMs: 5000 },
    });
    const service = createBookingService({
      db: tight,
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics: {
        increment: (metric) => {
          counted.push(metric);
          return Promise.resolve();
        },
      },
    });

    // Hold the only connection in a long transaction.
    const { release, occupier } = await occupy(tight);

    const outcomes = await Promise.all(
      [1, 2, 3].map((n) =>
        service.holdSeats(buyer(n), event.id, seatIds).then(
          () => "held",
          (error: unknown) =>
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "OTHER",
        ),
      ),
    );
    release();
    await occupier;

    expect(outcomes).toEqual(["BOOKING_BUSY", "BOOKING_BUSY", "BOOKING_BUSY"]);
    await expect.poll(() => counted.filter((m) => m === "booking_busy").length).toBe(3);
  });

  test("a hold blocked on a seat row lock past lock_timeout gives up and is BOOKING_BUSY", async () => {
    const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await seeder().seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "desc" },
    });
    // A generous transaction runtime timeout, so only the database lock_timeout can end the wait
    // (a Prisma P2028 would otherwise be mistaken for it).
    patient = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      transaction: { maxWaitMs: 60_000, timeoutMs: 60_000 },
    });
    const service = createBookingService({
      db: patient,
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics: { increment: () => Promise.resolve() },
    });

    // The blocker locks the row but leaves it AVAILABLE, so the lock-free snapshot lets the hold
    // through to the locked read, where it blocks. It is released only after lock_timeout (3s)
    // and every retry (3 x 3s) would have expired: without timeouts the hold would then succeed.
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = seeder().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seat.id} FOR UPDATE`;
        locked();
        await new Promise((resolve) => setTimeout(resolve, 16_000));
      },
      { timeout: 30_000 },
    );
    await lockTaken;

    const outcome = await service.holdSeats(buyer(7), event.id, [seat.id]).then(
      () => "held",
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "OTHER",
    );
    await blocker;

    expect(outcome).toBe("BOOKING_BUSY");
  }, 40_000);

  test("a placeOrder blocked on a seat row lock past lock_timeout is BOOKING_BUSY, counted", async () => {
    const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await seeder().seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "desc" },
    });
    const counted: string[] = [];
    patient ??= createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      transaction: { maxWaitMs: 60_000, timeoutMs: 60_000 },
    });
    const service = createBookingService({
      db: patient,
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics: {
        increment: (metric) => {
          counted.push(metric);
          return Promise.resolve();
        },
      },
    });
    const owner = buyer(8);
    const hold = await service.holdSeats(owner, event.id, [seat.id]);

    const locked = latch();
    const blocker = seeder().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seat.id}::uuid FOR UPDATE`;
        locked.open();
        await new Promise((resolve) => setTimeout(resolve, 16_000));
      },
      { timeout: 30_000 },
    );
    await locked.promise;

    const outcome = await service
      .placeOrder(owner, hold.id, { email: "busy@example.com" }, randomUUID())
      .then(
        () => "placed",
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "OTHER",
      );
    await blocker;

    expect(outcome).toBe("BOOKING_BUSY");
    await expect.poll(() => counted.filter((m) => m === "booking_busy").length).toBe(1);
    expect(counted.filter((m) => m === "deadlock_retry")).toHaveLength(3);
  }, 40_000);

  test("pool saturation surfaces the pg-pool message the service matches (pinned against the driver)", async () => {
    const client = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      poolMax: 1,
      acquireTimeoutMs: 100,
    });
    const { release, occupier } = await occupy(client);
    try {
      const failure = await client.$queryRaw`SELECT 1`.catch((error: unknown) => error);

      expect(String(failure)).toContain(POOL_ACQUIRE_TIMEOUT_MESSAGE);
    } finally {
      release();
      await occupier;
      await client.$disconnect();
    }
  });

  test("a transaction that outlives its own runtime timeout is not a retryable BOOKING_BUSY", async () => {
    const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await seeder().seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
    });
    const counted: string[] = [];
    const impatient = createPrismaClient({
      connectionString: database.url,
      driver: "pg",
      transaction: { maxWaitMs: 5000, timeoutMs: 500 },
    });
    const service = createBookingService({
      db: impatient,
      clock: { now: () => NOW },
      newId: randomUUID,
      metrics: {
        increment: (metric) => {
          counted.push(metric);
          return Promise.resolve();
        },
      },
    });
    const locked = latch();
    const finish = latch();
    let blockerPid = 0;
    const blocker = seeder().$transaction(
      async (tx) => {
        blockerPid = await backendPid(tx);
        await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seat.id}::uuid FOR UPDATE`;
        locked.open();
        await finish.promise;
      },
      { timeout: 30_000 },
    );
    await locked.promise;

    const attempt = service
      .holdSeats(buyer(9), event.id, [seat.id])
      .catch((error: unknown) => error);
    await waitUntilBlockedBy(seeder(), blockerPid);
    // Release after the 500 ms runtime timeout but well inside lock_timeout, so the hold's next
    // statement meets an expired transaction (P2028) rather than a database lock timeout.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    finish.open();
    const failure = await attempt;
    await blocker;
    await impatient.$disconnect();

    expect(failure).toMatchObject({ code: "P2028" });
    expect(failure).not.toMatchObject({ code: "BOOKING_BUSY" });
    expect(counted).not.toContain("booking_busy");
  });
});
