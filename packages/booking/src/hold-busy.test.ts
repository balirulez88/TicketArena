import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./index";
import { type Occupation, type OccupyOptions, occupy } from "./testing";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
let seedClient: PrismaClient | undefined;

function seeder(): PrismaClient {
  seedClient ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return seedClient;
}

function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(seeder(), NOW);
});

afterAll(async () => {
  await seedClient?.$disconnect();
});

/** Releases the occupation however the work ends, so a failure cannot leave its transaction open. */
async function held<T>(occupation: Occupation, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await occupation.release();
  }
}

describe("BOOKING_BUSY", () => {
  async function expectHoldsRefusedAsBusy(occupyOptions?: OccupyOptions): Promise<void> {
    const event = await seeder().event.findFirstOrThrow({ where: { demo: true } });
    const seats = await seeder().seat.findMany({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
      take: 1,
    });
    const seatIds = seats.map((seat) => seat.id);
    const counted: string[] = [];
    // One connection and a short wait: concurrent callers queue behind the lock holder below.
    const tight = createPrismaClient({
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

    try {
      const occupation = await occupy(tight, occupyOptions);

      const outcomes = await held(occupation, () =>
        Promise.all(
          [1, 2, 3].map((n) =>
            service.holdSeats(buyer(n), event.id, seatIds).then(
              () => "held",
              (error: unknown) =>
                typeof error === "object" && error !== null && "code" in error
                  ? String(error.code)
                  : "OTHER",
            ),
          ),
        ),
      );

      expect(outcomes).toEqual(["BOOKING_BUSY", "BOOKING_BUSY", "BOOKING_BUSY"]);
      await expect.poll(() => counted.filter((m) => m === "booking_busy").length).toBe(3);
    } finally {
      await tight.$disconnect();
    }
  }

  test("a hold that cannot get a connection or start its transaction in time is retryable BOOKING_BUSY", async () => {
    await expectHoldsRefusedAsBusy();
  });

  test("holds wait for an occupier that is slow to start", async () => {
    await expectHoldsRefusedAsBusy({
      beforeStart: () => new Promise((resolve) => setTimeout(resolve, 150)),
    });
  });
});
