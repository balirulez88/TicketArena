import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, it } from "vitest";
import { createPrismaClient } from "./index";
import { seedCatalog } from "./seed";

// Runs in declaration order and shuffled (vitest.config.ts): no test may rely on another's writes.
// Each test opens its own client and disconnects it when it ends. The shared booking test helpers
// (@ticketarena/booking/testing) cannot be used here: booking depends on this package.
const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");

describe("seedCatalog", () => {
  it("concurrent runs leave exactly one row per venue", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      await Promise.all(Array.from({ length: 5 }, () => seedCatalog(db, NOW)));

      const names = (await db.venue.findMany({ select: { name: true } })).map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      await db.$disconnect();
    }
  });

  it("has an index on seats.holdId", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      const indexes = await db.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'seats'`;
      expect(indexes.some((index) => /\("holdId"\)$/.test(index.indexdef))).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });

  it("creates venues, events with exactly one demo event, and available seats", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      await seedCatalog(db, NOW);

      const venues = await db.venue.count();
      const events = await db.event.findMany({
        include: { _count: { select: { seats: true } } },
      });
      const seatStatuses = await db.seat.groupBy({ by: ["status"], _count: true });

      expect(venues).toBeGreaterThanOrEqual(1);
      expect(venues).toBeLessThanOrEqual(2);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.length).toBeLessThanOrEqual(3);
      expect(events.filter((event) => event.demo)).toHaveLength(1);
      expect(events.every((event) => event._count.seats > 0)).toBe(true);
      expect(seatStatuses.map((group) => group.status)).toEqual(["AVAILABLE"]);
    } finally {
      await db.$disconnect();
    }
  });

  it("puts the demo event on sale before the seeding instant, with its queue closed; the others are upcoming", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      await seedCatalog(db, NOW);

      const demo = await db.event.findFirstOrThrow({ where: { demo: true } });
      const others = await db.event.findMany({ where: { demo: false } });

      // holdSeats refuses before onSaleAt, so the demo (run race, holds) must be on sale at once.
      expect(demo.onSaleAt.getTime()).toBeLessThan(NOW.getTime());
      expect(demo.queueClosesAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      expect(others.every((event) => event.onSaleAt.getTime() > NOW.getTime())).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });

  it("is idempotent: a second run changes no row counts", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      const count = async () => ({
        venues: await db.venue.count(),
        sections: await db.section.count(),
        rows: await db.row.count(),
        events: await db.event.count(),
        seats: await db.seat.count(),
      });
      await seedCatalog(db, NOW);
      const before = await count();

      await seedCatalog(db, NOW);

      expect(await count()).toEqual(before);
    } finally {
      await db.$disconnect();
    }
  });

  it("leaves seat state alone on re-run", async () => {
    const db = createPrismaClient({ connectionString: database.url, driver: "pg" });
    try {
      await seedCatalog(db, NOW);
      // Chosen explicitly, and sold only for this test: the seat with the highest id.
      const seat = await db.seat.findFirstOrThrow({ orderBy: { id: "desc" } });
      await db.seat.update({ where: { id: seat.id }, data: { status: "SOLD" } });
      try {
        await seedCatalog(db, NOW);

        expect((await db.seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe("SOLD");
      } finally {
        await db.seat.update({ where: { id: seat.id }, data: { status: "AVAILABLE" } });
      }
    } finally {
      await db.$disconnect();
    }
  });
});
