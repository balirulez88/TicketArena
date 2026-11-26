import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setupEmptyTestDatabase } from "@ticketarena/test-infra";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// TD-028: a database that the old check-then-create seed filled with duplicate venue names must
// still take the unique `venues.name` index. The database stops at the last migration that existed
// before it (`orders`), gets two same-name venues with sections, rows, events and seats, and then
// takes every later migration exactly as `prisma migrate deploy` would: in name order.
const database = setupEmptyTestDatabase();
const MIGRATIONS = resolve(__dirname, "../prisma/migrations");
const LAST_BEFORE_UNIQUE_VENUE_NAME = "20261030020000_orders";

const SURVIVOR = "00000000-0000-4000-8000-000000000001";
const DUPLICATE = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";

let client: pg.Client;

function migrations(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function apply(names: readonly string[]): Promise<void> {
  for (const name of names) {
    await client.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
  }
}

/** Two "Arena Central" rows (each with a Floor, one with a Balcony) and an unrelated venue. */
async function seedDuplicates(): Promise<void> {
  await client.query(`
    INSERT INTO venues (id, name) VALUES
      ('${SURVIVOR}', 'Arena Central'), ('${DUPLICATE}', 'Arena Central'), ('${OTHER}', 'Riverside');
    INSERT INTO sections (id, "venueId", name, "priceMinor") VALUES
      ('10000000-0000-4000-8000-000000000001', '${SURVIVOR}', 'Floor', 12500),
      ('10000000-0000-4000-8000-000000000002', '${DUPLICATE}', 'Floor', 9900),
      ('10000000-0000-4000-8000-000000000003', '${DUPLICATE}', 'Balcony', 6500),
      ('10000000-0000-4000-8000-000000000004', '${OTHER}', 'Floor', 8000);
    INSERT INTO rows (id, "sectionId", label) VALUES
      ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'A'),
      ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'A'),
      ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'B'),
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

async function rowsOf<T>(sql: string): Promise<T[]> {
  return (await client.query(sql)).rows;
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  const all = migrations();
  const cut = all.indexOf(LAST_BEFORE_UNIQUE_VENUE_NAME) + 1;
  expect(cut).toBeGreaterThan(0);
  await apply(all.slice(0, cut));
  await seedDuplicates();
  await apply(all.slice(cut));
});

afterAll(async () => {
  await client.end();
});

describe("the unique venues.name migration on a database with duplicate venue names", () => {
  it("keeps one venue per name: the one with the lowest id", async () => {
    expect(await rowsOf("SELECT id, name FROM venues ORDER BY name")).toEqual([
      { id: SURVIVOR, name: "Arena Central" },
      { id: OTHER, name: "Riverside" },
    ]);
  });

  it("points every event at the surviving venue", async () => {
    expect(await rowsOf(`SELECT name, "venueId" FROM events ORDER BY name`)).toEqual([
      { name: "Demo Race", venueId: SURVIVOR },
      { name: "Jazz Night", venueId: OTHER },
      { name: "Midnight Symphony", venueId: SURVIVOR },
    ]);
  });

  it("moves sections to the survivor and merges a same-name section into the survivor's", async () => {
    expect(
      await rowsOf(
        `SELECT id, "venueId", name, "priceMinor" FROM sections ORDER BY "venueId", name`,
      ),
    ).toEqual([
      {
        id: "10000000-0000-4000-8000-000000000003",
        venueId: SURVIVOR,
        name: "Balcony",
        priceMinor: 6500,
      },
      {
        id: "10000000-0000-4000-8000-000000000001",
        venueId: SURVIVOR,
        name: "Floor",
        priceMinor: 12500,
      },
      {
        id: "10000000-0000-4000-8000-000000000004",
        venueId: OTHER,
        name: "Floor",
        priceMinor: 8000,
      },
    ]);
  });

  it("merges same-label rows and keeps every seat, each on its venue's surviving rows", async () => {
    expect(
      await rowsOf(`
        SELECT s.name AS section, r.label, count(seat.id)::int AS seats
        FROM rows r JOIN sections s ON s.id = r."sectionId" LEFT JOIN seats seat ON seat."rowId" = r.id
        WHERE s."venueId" = '${SURVIVOR}'
        GROUP BY s.name, r.label ORDER BY s.name, r.label`),
    ).toEqual([
      { section: "Balcony", label: "D", seats: 1 },
      { section: "Floor", label: "A", seats: 2 },
      { section: "Floor", label: "B", seats: 1 },
    ]);
    expect(await rowsOf("SELECT count(*)::int AS seats FROM seats")).toEqual([{ seats: 5 }]);
  });

  it("leaves the unique index in place", async () => {
    await expect(
      client.query(`INSERT INTO venues (id, name) VALUES (gen_random_uuid(), 'Arena Central')`),
    ).rejects.toThrow(/venues_name_key/);
  });
});
