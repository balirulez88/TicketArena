import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function client(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("catalog schema", () => {
  it("stores a venue with a priced section, row and a per-event seat that defaults to AVAILABLE", async () => {
    const venue = await client().venue.create({ data: { name: "Test Arena" } });
    const section = await client().section.create({
      data: { venueId: venue.id, name: "Floor", priceMinor: 12_500 },
    });
    const row = await client().row.create({ data: { sectionId: section.id, label: "A" } });
    const event = await client().event.create({
      data: {
        venueId: venue.id,
        name: "Opening Night",
        onSaleAt: new Date("2027-01-01T10:00:00.000Z"),
        queueOpensAt: new Date("2027-01-01T09:55:00.000Z"),
        queueClosesAt: new Date("2027-01-01T11:00:00.000Z"),
      },
    });
    const seat = await client().seat.create({
      data: { eventId: event.id, rowId: row.id, number: 1 },
    });

    expect(section.currency).toBe("EUR");
    expect(section.priceMinor).toBe(12_500);
    expect(event.demo).toBe(false);
    expect(seat.status).toBe("AVAILABLE");
    expect(seat.holdId).toBeNull();
    expect(seat.claimBuyerKey).toBeNull();
  });

  it("rejects a second seat with the same row and number for one event", async () => {
    const venue = await client().venue.create({ data: { name: "Dup Arena" } });
    const section = await client().section.create({
      data: { venueId: venue.id, name: "Balcony", priceMinor: 5_000 },
    });
    const row = await client().row.create({ data: { sectionId: section.id, label: "B" } });
    const event = await client().event.create({
      data: {
        venueId: venue.id,
        name: "Dup Night",
        onSaleAt: new Date("2027-02-01T10:00:00.000Z"),
        queueOpensAt: new Date("2027-02-01T09:55:00.000Z"),
        queueClosesAt: new Date("2027-02-01T11:00:00.000Z"),
      },
    });
    await client().seat.create({ data: { eventId: event.id, rowId: row.id, number: 7 } });

    await expect(
      client().seat.create({ data: { eventId: event.id, rowId: row.id, number: 7 } }),
    ).rejects.toThrow();
  });
});
