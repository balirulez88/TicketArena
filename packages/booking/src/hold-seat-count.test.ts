import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const MAX_SEATS_PER_HOLD = 6;

function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
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

function service() {
  return createBookingService({ db: db(), clock: { now: () => NOW }, newId: randomUUID });
}

describe("holdSeats seat count", () => {
  test("holds all six seats of a full selection in one action", async () => {
    const { eventId, seatIds } = await freeSeats(MAX_SEATS_PER_HOLD);
    const hold = await service().holdSeats(buyer(1), eventId, seatIds);
    expect(hold.status).toBe("HELD");
    expect([...hold.seatIds].sort()).toEqual([...seatIds].sort());
  });

  test("refuses a seventh seat without holding any of them", async () => {
    const { eventId, seatIds } = await freeSeats(MAX_SEATS_PER_HOLD + 1);
    await expect(service().holdSeats(buyer(2), eventId, seatIds)).rejects.toMatchObject({
      code: "INVALID_SEAT_SELECTION",
    });
    expect(await db().seat.count({ where: { id: { in: seatIds }, status: "HELD" } })).toBe(0);
  });
});
