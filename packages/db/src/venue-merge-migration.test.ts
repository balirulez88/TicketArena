import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupEmptyTestDatabase, type TestDatabase } from "@ticketarena/test-infra";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// TD-028: a database that the old check-then-create seed filled with duplicate venue names must
// still take the unique `venues.name` index. Each database stops at the last migration that existed
// before it (`orders`), gets two same-name venues with sections, rows, events and seats, and then
// takes every later migration exactly as `prisma migrate deploy` would: in name order.
const MIGRATIONS = resolve(__dirname, "../prisma/migrations");
const LAST_BEFORE_UNIQUE_VENUE_NAME = "20261030020000_orders";

const SURVIVOR = "00000000-0000-4000-8000-000000000001";
const DUPLICATE = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const SURVIVOR_FLOOR = "10000000-0000-4000-8000-000000000001";
const DUPLICATE_FLOOR = "10000000-0000-4000-8000-000000000002";

interface Price {
  priceMinor: number;
  currency: string;
}

interface SeatPrice extends Price {
  id: string;
}

function migrations(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function apply(client: pg.Client, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await client.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  }
}

/**
 * Two "Arena Central" rows (each with a Floor, one with a Balcony) and an unrelated venue. The
 * survivor's Floor costs 12,500 EUR; the duplicate's Floor costs `duplicateFloor`.
 */
async function seedDuplicates(client: pg.Client, duplicateFloor: Price): Promise<void> {
  await client.query(`
    INSERT INTO venues (id, name) VALUES
      ('${SURVIVOR}', 'Arena Central'), ('${DUPLICATE}', 'Arena Central'), ('${OTHER}', 'Riverside');
    INSERT INTO sections (id, "venueId", name, "priceMinor", currency) VALUES
      ('${SURVIVOR_FLOOR}', '${SURVIVOR}', 'Floor', 12500, 'EUR'),
      ('${DUPLICATE_FLOOR}', '${DUPLICATE}', 'Floor', ${duplicateFloor.priceMinor}, '${duplicateFloor.currency}'),
      ('10000000-0000-4000-8000-000000000003', '${DUPLICATE}', 'Balcony', 6500, 'EUR'),
      ('10000000-0000-4000-8000-000000000004', '${OTHER}', 'Floor', 8000, 'EUR');
    INSERT INTO rows (id, "sectionId", label) VALUES
      ('20000000-0000-4000-8000-000000000001', '${SURVIVOR_FLOOR}', 'A'),
      ('20000000-0000-4000-8000-000000000002', '${DUPLICATE_FLOOR}', 'A'),
      ('20000000-0000-4000-8000-000000000003', '${DUPLICATE_FLOOR}', 'B'),
      ('20000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000003', 'D'),
      ('20000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000004', 'A');
    INSERT INTO events (id, "venueId", name, "onSaleAt", "queueOpensAt", "queueClosesAt") VALUES
      ('30000000-0000-4000-8000-000000000001', '${SURVIVOR}', 'Demo Race', now(), now(), now()),
      ('30000000-0000-4000-8000-000000000002', '${DUPLICATE}', 'Midnight Symphony', now(), now(), now()),
      ('30000000-0000-4000-8000-000000000003', '${OTHER}', 'Jazz Night', now(), now(), now());
    INSERT INTO seats (id, "eventId", "rowId", number) VALUES
      (gen_random_uuid(), '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 1),
      (gen_random_uuid(), '30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 1),
      (gen_random_uuid(), '30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000003', 1),
      (gen_random_uuid(), '30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000004', 1),
      (gen_random_uuid(), '30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000005', 1);
  `);
}

async function rowsOf<T>(client: pg.Client, sql: string): Promise<T[]> {
  return (await client.query(sql)).rows;
}

/** The price and currency each seat sells at: its section's, as the seat map and checkout read it. */
function seatPrices(client: pg.Client): Promise<SeatPrice[]> {
  return rowsOf<SeatPrice>(
    client,
    `SELECT seat.id, s."priceMinor", s.currency
     FROM seats seat JOIN rows r ON r.id = seat."rowId" JOIN sections s ON s.id = r."sectionId"
     ORDER BY seat.id`,
  );
}

interface MigratedDatabase {
  readonly client: () => pg.Client;
  /** The migrations from the merge onwards, not yet applied. */
  readonly rest: () => readonly string[];
}

/** A fresh database migrated up to just before the merge, holding the duplicates. */
function migratedWithDuplicates(database: TestDatabase, duplicateFloor: Price): MigratedDatabase {
  let client: pg.Client | undefined;
  let rest: string[] = [];
  beforeAll(async () => {
    client = new pg.Client({ connectionString: database.url });
    await client.connect();
    const all = migrations();
    const cut = all.indexOf(LAST_BEFORE_UNIQUE_VENUE_NAME) + 1;
    expect(cut).toBeGreaterThan(0);
    await apply(client, all.slice(0, cut));
    await seedDuplicates(client, duplicateFloor);
    rest = all.slice(cut);
  });
  afterAll(async () => {
    await client?.end();
  });
  return {
    client: () => {
      if (client === undefined) {
        throw new Error(
          "migratedWithDuplicates: the client is available only inside tests and hooks",
        );
      }
      return client;
    },
    rest: () => rest,
  };
}

describe("the unique venues.name migration on duplicates whose same-name sections agree on price", () => {
  const db = migratedWithDuplicates(setupEmptyTestDatabase(), {
    priceMinor: 12500,
    currency: "EUR",
  });
  let pricesBefore: SeatPrice[] = [];

  beforeAll(async () => {
    pricesBefore = await seatPrices(db.client());
    await apply(db.client(), db.rest());
  });

  it("keeps one venue per name: the one with the lowest id", async () => {
    expect(await rowsOf(db.client(), "SELECT id, name FROM venues ORDER BY name")).toEqual([
      { id: SURVIVOR, name: "Arena Central" },
      { id: OTHER, name: "Riverside" },
    ]);
  });

  it("points every event at the surviving venue", async () => {
    expect(await rowsOf(db.client(), `SELECT name, "venueId" FROM events ORDER BY name`)).toEqual([
      { name: "Demo Race", venueId: SURVIVOR },
      { name: "Jazz Night", venueId: OTHER },
      { name: "Midnight Symphony", venueId: SURVIVOR },
    ]);
  });

  it("moves sections to the survivor and merges a same-name section into the survivor's", async () => {
    expect(
      await rowsOf(
        db.client(),
        `SELECT id, "venueId", name, "priceMinor", currency FROM sections ORDER BY "venueId", name`,
      ),
    ).toEqual([
      {
        id: "10000000-0000-4000-8000-000000000003",
        venueId: SURVIVOR,
        name: "Balcony",
        priceMinor: 6500,
        currency: "EUR",
      },
      { id: SURVIVOR_FLOOR, venueId: SURVIVOR, name: "Floor", priceMinor: 12500, currency: "EUR" },
      {
        id: "10000000-0000-4000-8000-000000000004",
        venueId: OTHER,
        name: "Floor",
        priceMinor: 8000,
        currency: "EUR",
      },
    ]);
  });

  it("sells every existing seat at the price and currency it had before the merge", async () => {
    expect(pricesBefore).toHaveLength(5);
    expect(await seatPrices(db.client())).toEqual(pricesBefore);
  });

  it("merges same-label rows and keeps every seat, each on its venue's surviving rows", async () => {
    expect(
      await rowsOf(
        db.client(),
        `SELECT s.name AS section, r.label, count(seat.id)::int AS seats
         FROM rows r JOIN sections s ON s.id = r."sectionId" LEFT JOIN seats seat ON seat."rowId" = r.id
         WHERE s."venueId" = '${SURVIVOR}'
         GROUP BY s.name, r.label ORDER BY s.name, r.label`,
      ),
    ).toEqual([
      { section: "Balcony", label: "D", seats: 1 },
      { section: "Floor", label: "A", seats: 2 },
      { section: "Floor", label: "B", seats: 1 },
    ]);
    expect(await rowsOf(db.client(), "SELECT count(*)::int AS seats FROM seats")).toEqual([
      { seats: 5 },
    ]);
  });

  it("leaves the unique index in place", async () => {
    await expect(
      db
        .client()
        .query(`INSERT INTO venues (id, name) VALUES (gen_random_uuid(), 'Arena Central')`),
    ).rejects.toThrow(/venues_name_key/);
  });
});

// Merging a same-name section at another price or currency would silently reprice its seats on
// the seat map and at checkout, so the migration refuses and leaves the choice to an operator.
describe.each([
  { conflict: "price", duplicateFloor: { priceMinor: 9900, currency: "EUR" } },
  { conflict: "currency", duplicateFloor: { priceMinor: 12500, currency: "USD" } },
])(
  "the unique venues.name migration on same-name sections that differ in $conflict",
  ({ duplicateFloor }) => {
    const db = migratedWithDuplicates(setupEmptyTestDatabase(), duplicateFloor);
    let pricesBefore: SeatPrice[] = [];
    let failure: unknown;

    beforeAll(async () => {
      pricesBefore = await seatPrices(db.client());
      failure = await apply(db.client(), db.rest()).then(
        () => undefined,
        (error: unknown) => error,
      );
    });

    it("aborts with an error naming the venue, the section, both prices and the fix", () => {
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain('venue "Arena Central"');
      expect(message).toContain('section "Floor"');
      expect(message).toContain(`${SURVIVOR_FLOOR} 12500 EUR`);
      expect(message).toContain(
        `${DUPLICATE_FLOOR} ${duplicateFloor.priceMinor} ${duplicateFloor.currency}`,
      );
      expect(message).toContain("same priceMinor and currency");
    });

    it("changes no venue, section or seat and does not create the unique index", async () => {
      expect(await rowsOf(db.client(), "SELECT count(*)::int AS venues FROM venues")).toEqual([
        { venues: 3 },
      ]);
      expect(await rowsOf(db.client(), "SELECT count(*)::int AS sections FROM sections")).toEqual([
        { sections: 4 },
      ]);
      expect(await seatPrices(db.client())).toEqual(pricesBefore);
      expect(
        await rowsOf(
          db.client(),
          `SELECT indexname FROM pg_indexes WHERE indexname = 'venues_name_key'`,
        ),
      ).toEqual([]);
    });
  },
);
