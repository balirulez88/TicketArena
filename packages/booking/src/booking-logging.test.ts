import { randomUUID } from "node:crypto";
import type { Logger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./booking-service";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };

type Bindings = Record<string, unknown>;

/** Records the bindings every line is written with, whichever child wrote it. */
function recordingLogger() {
  const lines: Bindings[] = [];
  const make = (bound: Bindings): Logger => {
    const write = (fields: object) => {
      lines.push({ ...bound, ...fields });
    };
    return {
      info: write,
      warn: write,
      error: write,
      child: (bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("booking logging", () => {
  test("every line about a booking carries its correlationId, holdId and, once placed, orderId", async () => {
    const { logger, lines } = recordingLogger();
    const booking = createBookingService({
      db: db(),
      clock: { now: () => NOW },
      newId: randomUUID,
      logger,
    });
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seat = await db().seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
    });

    const hold = await booking.holdSeats(alice, event.id, [seat.id]);
    const held = lines.length;
    const order = await booking.placeOrder(
      alice,
      hold.id,
      { email: "alice@example.com" },
      randomUUID(),
    );

    expect(held).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(held);
    for (const line of lines) {
      expect(line).toMatchObject({ correlationId: hold.correlationId, holdId: hold.id });
    }
    for (const line of lines.slice(held)) {
      expect(line).toMatchObject({ orderId: order.id });
    }
  });
});
