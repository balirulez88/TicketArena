import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Buyer,
  createBookingService,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  IdempotencyKeyReusedError,
  SeatUnavailableError,
} from "./booking-service";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");
const alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };
const contact = { email: "alice@example.com" };

function service(now = NOW) {
  return createBookingService({ db: db(), clock: { now: () => now }, newId: randomUUID });
}

async function heldSeat() {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seat = await db().seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
  });
  const hold = await service().holdSeats(alice, event.id, [seat.id]);
  return { hold, seatId: seat.id };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("placeOrder", () => {
  test("turns a valid hold into a PENDING_PAYMENT order due 5 minutes after the clock reading", async () => {
    const { hold, seatId } = await heldSeat();
    const placedAt = new Date("2027-03-01T12:02:00.000Z");

    const order = await service(placedAt).placeOrder(alice, hold.id, contact, randomUUID());

    expect(order).toMatchObject({
      holdId: hold.id,
      status: "PENDING_PAYMENT",
      paymentDeadline: new Date("2027-03-01T12:07:00.000Z"),
      correlationId: hold.correlationId,
      contact,
    });
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "ORDERED" });
    const seat = await db().seat.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.status).toBe("IN_CHECKOUT");
  });

  test("copies seat prices into order lines and writes order.placed in the same transaction", async () => {
    const { hold, seatId } = await heldSeat();
    const order = await service().placeOrder(
      alice,
      hold.id,
      { ...contact, phone: "+3612345" },
      randomUUID(),
    );

    const seat = await db().seat.findUniqueOrThrow({
      where: { id: seatId },
      include: { row: { include: { section: true } } },
    });
    const price = seat.row.section.priceMinor;
    expect(order.totalMinor).toBe(price);
    expect(order.lines).toEqual([{ seatId, priceMinor: price, currency: "EUR" }]);
    expect(order.contact).toEqual({ ...contact, phone: "+3612345" });

    const events = await db().outboxEvent.findMany({ where: { aggregateId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "order.placed",
      payload: {
        type: "order.placed",
        orderId: order.id,
        correlationId: hold.correlationId,
        payload: { amountMinor: price, currency: "EUR" },
      },
    });
  });

  test("returns the same order for a repeated idempotencyKey, even after the hold expired", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();
    const first = await service().placeOrder(alice, hold.id, contact, key);

    const replay = await service(new Date("2027-03-01T13:00:00.000Z")).placeOrder(
      alice,
      hold.id,
      contact,
      key,
    );

    expect(replay).toEqual(first);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(1);
  });

  test("resolves concurrent duplicates to a single order", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();

    const orders = await Promise.all(
      Array.from({ length: 5 }, () => service().placeOrder(alice, hold.id, contact, key)),
    );

    expect(new Set(orders.map((order) => order.id)).size).toBe(1);
  });

  test("rejects a reused key carrying a different request", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();
    await service().placeOrder(alice, hold.id, contact, key);

    await expect(
      service().placeOrder(alice, hold.id, { email: "other@example.com" }, key),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  test("hides a hold from anyone but its owner", async () => {
    const { hold } = await heldSeat();
    const bob: Buyer = { sessionId: "b".repeat(32), buyerKey: "b".repeat(32) };

    await expect(service().placeOrder(bob, hold.id, contact, randomUUID())).rejects.toBeInstanceOf(
      HoldNotFoundError,
    );
    await expect(
      service().placeOrder(alice, randomUUID(), contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldNotFoundError);
  });

  test("refuses an expired hold and leaves the seat held", async () => {
    const { hold, seatId } = await heldSeat();

    await expect(
      service(hold.holdExpiresAt).placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldExpiredError);
    const seat = await db().seat.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.status).toBe("HELD");
  });

  test("refuses a hold that is already ordered under another key", async () => {
    const { hold } = await heldSeat();
    await service().placeOrder(alice, hold.id, contact, randomUUID());

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldNotActiveError);
  });

  test("getOrder returns the order to its owner only", async () => {
    const { hold } = await heldSeat();
    const order = await service().placeOrder(alice, hold.id, contact, randomUUID());
    const bob: Buyer = { sessionId: "b".repeat(32), buyerKey: "b".repeat(32) };

    expect(await service().getOrder(alice, order.id)).toEqual(order);
    expect(await service().getOrder(bob, order.id)).toBeNull();
  });
});

describe("placeOrder acceptance: lock order and consistency", () => {
  async function isLocked(table: "holds" | "seats", id: string): Promise<boolean> {
    try {
      await db().$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE NOWAIT`,
          id,
        );
      });
      return false;
    } catch {
      return true;
    }
  }

  test("reads the clock only after the hold and its seats are locked", async () => {
    const { hold, seatId } = await heldSeat();
    let locked: boolean[] = [];
    const probing = createBookingService({
      db: db(),
      newId: randomUUID,
      clock: {
        now: () => {
          // Synchronous clock: record the probes' promises and resolve them afterwards.
          pending = Promise.all([isLocked("holds", hold.id), isLocked("seats", seatId)]);
          return NOW;
        },
      },
    });
    let pending: Promise<boolean[]> = Promise.resolve([]);

    await probing.placeOrder(alice, hold.id, contact, randomUUID());
    locked = await pending;

    expect(locked).toEqual([true, true]);
  });

  test("locks the hold before the seats", async () => {
    const { hold, seatId } = await heldSeat();
    let started: Promise<unknown> = Promise.resolve();
    await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
      started = service().placeOrder(alice, hold.id, contact, randomUUID());
      // placeOrder now waits on the seat lock; it must already own the hold lock.
      await expect.poll(() => isLocked("holds", hold.id), { timeout: 5000 }).toBe(true);
    });
    await expect(started).resolves.toBeDefined();
  });

  test("refuses when a held seat lost its holdId", async () => {
    const { hold, seatId } = await heldSeat();
    await db().seat.update({ where: { id: seatId }, data: { holdId: null } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
  });

  test("refuses when a seat of the hold is no longer HELD", async () => {
    const { hold, seatId } = await heldSeat();
    await db().seat.update({ where: { id: seatId }, data: { status: "AVAILABLE" } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
  });
});
