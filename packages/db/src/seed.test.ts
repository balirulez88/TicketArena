import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient, type PrismaClient } from "./index";
import { seedCatalog } from "./seed";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function client(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

afterAll(async () => {
  await prisma?.$disconnect();
});

const NOW = new Date("2027-03-01T12:00:00.000Z");

describe("seedCatalog", () => {
  it("creates venues, events with exactly one demo event, and available seats", async () => {
    await seedCatalog(client(), NOW);

    const venues = await client().venue.count();
    const events = await client().event.findMany({
      include: { _count: { select: { seats: true } } },
    });
    const seatStatuses = await client().seat.groupBy({ by: ["status"], _count: true });

    expect(venues).toBeGreaterThanOrEqual(1);
    expect(venues).toBeLessThanOrEqual(2);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(3);
    expect(events.filter((event) => event.demo)).toHaveLength(1);
    expect(events.every((event) => event._count.seats > 0)).toBe(true);
    expect(seatStatuses.map((group) => group.status)).toEqual(["AVAILABLE"]);
  });

  it("is idempotent: a second run changes no row counts", async () => {
    const count = async () => ({
      venues: await client().venue.count(),
      sections: await client().section.count(),
      rows: await client().row.count(),
      events: await client().event.count(),
      seats: await client().seat.count(),
    });
    await seedCatalog(client(), NOW);
    const before = await count();

    await seedCatalog(client(), NOW);

    expect(await count()).toEqual(before);
  });

  it("leaves seat state alone on re-run", async () => {
    await seedCatalog(client(), NOW);
    const seat = await client().seat.findFirstOrThrow();
    await client().seat.update({ where: { id: seat.id }, data: { status: "SOLD" } });

    await seedCatalog(client(), NOW);

    expect((await client().seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe("SOLD");
  });
});
