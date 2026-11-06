import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  createBookingService,
  InvalidSeatSelectionError,
  SeatUnavailableError,
} from "./booking-service";
import { backendPid, latch, waitUntilBlockedBy } from "./pg-blocking";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };
let bob: Buyer = { sessionId: "b".repeat(32), buyerKey: "b".repeat(32) };

beforeEach(() => {
  const [a, b] = [randomUUID().replaceAll("-", ""), randomUUID().replaceAll("-", "")];
  alice = { sessionId: a, buyerKey: a };
  bob = { sessionId: b, buyerKey: b };
});

function service(now = NOW) {
  return createBookingService({ db: db(), clock: { now: () => now }, newId: randomUUID });
}

async function freshSeats(count: number) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seats = await db().seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    take: count,
    orderBy: { id: "asc" },
  });
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("holdSeats", () => {
  test("holds an available seat for 10 minutes after the clock reading", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(hold.holdExpiresAt).toEqual(new Date("2027-03-01T12:10:00.000Z"));
    expect(hold.status).toBe("HELD");
    expect(hold.seatIds).toEqual(seatIds);
    const seat = await db().seat.findUniqueOrThrow({ where: { id: seatIds[0] ?? "" } });
    expect(seat).toMatchObject({
      status: "HELD",
      holdId: hold.id,
      claimBuyerKey: alice.buyerKey,
    });
  });

  test("writes a seat.held outbox event with the hold's correlationId in the same commit", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const hold = await service().holdSeats(alice, eventId, seatIds);

    const rows = await db().outboxEvent.findMany({ where: { aggregateId: hold.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: "seat.held", status: "PENDING" });
    expect(rows[0]?.payload).toMatchObject({
      id: rows[0]?.id,
      type: "seat.held",
      correlationId: hold.correlationId,
      causationId: null,
      holdId: hold.id,
      occurredAt: NOW.toISOString(),
      payload: {
        holdId: hold.id,
        eventId,
        seatIds,
        holdExpiresAt: "2027-03-01T12:10:00.000Z",
      },
    });
  });

  test("mints a different correlationId for each hold", async () => {
    const { eventId, seatIds } = await freshSeats(2);

    const first = await service().holdSeats(alice, eventId, [seatIds[0] ?? ""]);
    const second = await service().holdSeats(alice, eventId, [seatIds[1] ?? ""]);

    expect(first.correlationId).not.toBe(second.correlationId);
  });

  test("a held seat is SEAT_UNAVAILABLE naming its id, and nothing is written", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    await service().holdSeats(alice, eventId, seatIds);
    const holdsBefore = await db().hold.count();
    const outboxBefore = await db().outboxEvent.count();

    const failure = await service()
      .holdSeats(bob, eventId, seatIds)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeatUnavailableError);
    expect(failure).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds });
    expect(await db().hold.count()).toBe(holdsBefore);
    expect(await db().outboxEvent.count()).toBe(outboxBefore);
  });

  test("a seat of another event is SEAT_UNAVAILABLE", async () => {
    const { seatIds } = await freshSeats(1);
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });

    await expect(service().holdSeats(alice, other.id, seatIds)).rejects.toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds,
    });
  });

  test("two concurrent holds of one seat: exactly one wins", async () => {
    const { eventId, seatIds } = await freshSeats(1);

    const results = await Promise.allSettled([
      service().holdSeats(alice, eventId, seatIds),
      service().holdSeats(bob, eventId, seatIds),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [loser] = results.filter((result) => result.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(SeatUnavailableError);
  });

  test("reads the clock after taking the seat lock", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const seatId = seatIds[0] ?? "";
    const locked = latch();
    const commit = latch();
    let blockerPid = 0;
    const blocker = db().$transaction(async (tx) => {
      blockerPid = await backendPid(tx);
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
      locked.open();
      await commit.promise;
    });
    await locked.promise;
    // The clock is synchronous, so each read is stamped with the phase it happens in, there and
    // then. A read before the lock was granted can only happen while the blocker is uncommitted:
    // the hold is already blocked on the lock (awaited below) before the blocker is let go.
    const observer = createPrismaClient({ connectionString: database.url, driver: "pg" });
    let phase: "blocker-open" | "blocker-released" | "blocker-committed" = "blocker-open";
    const reads: string[] = [];
    const clock = {
      now: () => {
        reads.push(phase);
        return NOW;
      },
    };

    const held = createBookingService({ db: db(), clock, newId: randomUUID }).holdSeats(
      alice,
      eventId,
      seatIds,
    );
    await waitUntilBlockedBy(observer, blockerPid);
    phase = "blocker-released";
    commit.open();
    await blocker;
    phase = "blocker-committed";
    await held;
    await observer.$disconnect();

    expect(reads.length).toBeGreaterThan(0);
    // The first read is the advisory lock-free snapshot; the last is the decision time.
    expect(reads.at(-1)).not.toBe("blocker-open");
  });

  test("runs under lock_timeout 3s and statement_timeout 5s (ADR 0005)", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const seen: { lock: string; statement: string }[] = [];
    // Observe the settings from inside the service's own transaction, after it has set them.
    const observing = new Proxy(db(), {
      get(target, property) {
        if (property !== "$transaction") {
          return Reflect.get(target, property);
        }
        return (fn: (tx: PrismaClient) => Promise<unknown>, options?: object) =>
          target.$transaction(async (tx) => {
            const wrapped = new Proxy(tx as PrismaClient, {
              get(inner, name) {
                if (name !== "$executeRaw") {
                  return Reflect.get(inner, name);
                }
                return async (...args: Parameters<PrismaClient["$executeRaw"]>) => {
                  const result = await inner.$executeRaw(...args);
                  const [row] = await inner.$queryRaw<{ lock: string; statement: string }[]>`
                    SELECT current_setting('lock_timeout') AS lock,
                           current_setting('statement_timeout') AS statement`;
                  if (row) {
                    seen.push(row);
                  }
                  return result;
                };
              },
            });
            return fn(wrapped);
          }, options);
      },
    });

    await createBookingService({
      db: observing,
      clock: { now: () => NOW },
      newId: randomUUID,
    }).holdSeats(alice, eventId, seatIds);

    expect(seen).toContainEqual({ lock: "3s", statement: "5s" });
  });
});

describe("holdSeats seat selection", () => {
  test("rejects an empty seatIds list before writing anything", async () => {
    const { eventId } = await freshSeats(1);
    const before = await db().hold.count();

    await expect(service().holdSeats(alice, eventId, [])).rejects.toBeInstanceOf(
      InvalidSeatSelectionError,
    );
    expect(await db().hold.count()).toBe(before);
  });

  test("rejects a duplicated seatIds list before writing anything", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const seatId = seatIds[0] ?? "";
    const before = await db().hold.count();

    await expect(service().holdSeats(alice, eventId, [seatId, seatId])).rejects.toBeInstanceOf(
      InvalidSeatSelectionError,
    );
    expect(await db().hold.count()).toBe(before);
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("AVAILABLE");
  });
});

describe("getHold", () => {
  test("returns the hold to its owner", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(alice, hold.id)).toEqual(hold);
  });

  test("returns null to another buyer and for an unknown id", async () => {
    const { eventId, seatIds } = await freshSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(bob, hold.id)).toBeNull();
    expect(await service().getHold(alice, randomUUID())).toBeNull();
  });
});
