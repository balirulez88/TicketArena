import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService, createPaymentSagaHandler } from "./index";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const NOW = new Date("2027-03-01T12:00:00.000Z");

const service = (now = NOW) =>
  createBookingService({ db: db(), clock: { now: () => now }, newId: randomUUID });

/** A non-demo event is upcoming at NOW; holding its seats needs a clock past its on-sale. */
const onSale = (event: { onSaleAt: Date }) => service(event.onSaleAt);

/** Past every hold's expiry and every order's payment deadline plus settlement grace. */
const SWEPT_AT = new Date(NOW.getTime() + 11 * 60_000);
const sweeper = () =>
  createBookingService({ db: db(), clock: { now: () => SWEPT_AT }, newId: randomUUID });

function buyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

beforeAll(async () => {
  await seedCatalog(db(), NOW);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

async function demoEvent() {
  return db().event.findFirstOrThrow({ where: { demo: true } });
}

async function freeSeats(eventId: string, count: number): Promise<string[]> {
  const seats = await db().seat.findMany({
    where: { eventId, status: "AVAILABLE" },
    orderBy: { id: "asc" },
    take: count,
  });
  return seats.map((seat) => seat.id);
}

/** A placed order, still `PENDING_PAYMENT`, on one free seat of the event. */
async function placedOrder(eventId: string) {
  const owner = buyer();
  const hold = await service().holdSeats(owner, eventId, await freeSeats(eventId, 1));
  return service().placeOrder(owner, hold.id, { email: "buyer@example.com" }, randomUUID());
}

/** Moves an order to CONFIRMED the way the saga leaves it: seats SOLD, an APPLIED ledger row. */
async function confirm(orderId: string, holdId: string): Promise<string> {
  const paymentId = randomUUID();
  await db().order.update({ where: { id: orderId }, data: { status: "CONFIRMED" } });
  await db().seat.updateMany({ where: { holdId }, data: { status: "SOLD" } });
  await db().orderPayment.create({
    data: {
      paymentId,
      orderId,
      amount: 1000,
      currency: "EUR",
      capturedAt: NOW,
      disposition: "APPLIED",
    },
  });
  return paymentId;
}

describe("BookingService.resetEvent", () => {
  test("clears the demo event's holds, orders and ledger rows and frees its seats; keeps every other history", async () => {
    const event = await demoEvent();
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });
    await service().holdSeats(buyer(), event.id, await freeSeats(event.id, 2));
    const sold = await placedOrder(event.id);
    const paymentId = await confirm(sold.id, sold.holdId);
    // The Payment and Notification services' own history of the sale (ADR 0009).
    await db().paymentAttempt.create({
      data: {
        paymentId,
        orderId: sold.id,
        attemptNo: 1,
        status: "CAPTURED",
        capturedAt: NOW,
        amount: 1000,
        currency: "EUR",
        contactEmail: "buyer@example.com",
        createdAt: NOW,
      },
    });
    await db().notification.create({
      data: {
        id: randomUUID(),
        sourceEventId: randomUUID(),
        channel: "EMAIL",
        recipient: "buyer@example.com",
        template: "order-confirmed",
        createdAt: NOW,
      },
    });
    const otherHold = await onSale(other).holdSeats(
      buyer(),
      other.id,
      await freeSeats(other.id, 1),
    );
    const outboxBefore = await db().outboxEvent.count();

    const result = await service().resetEvent(event.id);

    expect(result).toEqual({
      eventId: event.id,
      holdsDeleted: 2,
      ordersDeleted: 1,
      ledgerRowsDeleted: 1,
      seatsFreed: 3,
    });
    expect(await db().hold.count({ where: { eventId: event.id } })).toBe(0);
    expect(await db().order.count({ where: { id: sold.id } })).toBe(0);
    expect(await db().orderLine.count({ where: { orderId: sold.id } })).toBe(0);
    expect(await db().orderPayment.count({ where: { orderId: sold.id } })).toBe(0);
    expect(
      await db().seat.count({
        where: {
          eventId: event.id,
          OR: [
            { status: { not: "AVAILABLE" } },
            { holdId: { not: null } },
            { claimBuyerKey: { not: null } },
          ],
        },
      }),
    ).toBe(0);
    expect(await db().hold.findUniqueOrThrow({ where: { id: otherHold.id } })).toMatchObject({
      status: "HELD",
    });
    expect(await db().seat.count({ where: { holdId: otherHold.id, status: "HELD" } })).toBe(1);
    expect(await db().outboxEvent.count()).toBe(outboxBefore);
    expect(await db().paymentAttempt.count({ where: { orderId: sold.id } })).toBe(1);
    expect(await db().notification.count()).toBe(1);
  });

  test("after a reset the demo event sells again from scratch", async () => {
    const event = await demoEvent();
    const [seatId = ""] = await freeSeats(event.id, 1);
    const first = buyer();
    await service().holdSeats(first, event.id, [seatId]);
    await service().resetEvent(event.id);

    const again = buyer();
    const hold = await service().holdSeats(again, event.id, [seatId]);
    const order = await service().placeOrder(
      again,
      hold.id,
      { email: "b@example.com" },
      randomUUID(),
    );

    expect(order.lines.map((line) => line.seatId)).toEqual([seatId]);
    await db().order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    await service().resetEvent(event.id);
  });

  test("a demo order awaiting payment blocks the reset, which then changes nothing", async () => {
    const event = await demoEvent();
    const pending = await placedOrder(event.id);
    const holdsBefore = await db().hold.count({ where: { eventId: event.id } });

    await expect(service().resetEvent(event.id)).rejects.toMatchObject({
      code: "RESET_BLOCKED",
      message: expect.stringContaining("PENDING_PAYMENT"),
    });

    expect(await db().hold.count({ where: { eventId: event.id } })).toBe(holdsBefore);
    expect(await db().order.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      status: "PENDING_PAYMENT",
    });
    await db().order.update({ where: { id: pending.id }, data: { status: "EXPIRED" } });
    await service().resetEvent(event.id);
  });

  test.each(["REFUND_REQUESTED", "MANUAL_REVIEW"] as const)(
    "an open refund obligation (%s) blocks the reset",
    async (disposition) => {
      const event = await demoEvent();
      const order = await placedOrder(event.id);
      await db().order.update({ where: { id: order.id }, data: { status: "EXPIRED" } });
      await db().orderPayment.create({
        data: {
          paymentId: randomUUID(),
          orderId: order.id,
          amount: 1000,
          currency: "EUR",
          capturedAt: NOW,
          disposition,
        },
      });

      await expect(service().resetEvent(event.id)).rejects.toMatchObject({
        code: "RESET_BLOCKED",
        message: expect.stringContaining("refund obligation"),
      });
      expect(await db().order.count({ where: { id: order.id } })).toBe(1);

      await db().orderPayment.updateMany({
        where: { orderId: order.id },
        data: { disposition: "REFUNDED" },
      });
      await expect(service().resetEvent(event.id)).resolves.toMatchObject({ ledgerRowsDeleted: 1 });
    },
  );

  test("an event that is not the demo event, or does not exist, is refused untouched", async () => {
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });
    await onSale(other).holdSeats(buyer(), other.id, await freeSeats(other.id, 1));
    const holdsBefore = await db().hold.count({ where: { eventId: other.id } });

    await expect(service().resetEvent(other.id)).rejects.toMatchObject({ code: "NOT_DEMO_EVENT" });
    await expect(service().resetEvent(randomUUID())).rejects.toMatchObject({
      code: "NOT_DEMO_EVENT",
    });
    expect(await db().hold.count({ where: { eventId: other.id } })).toBe(holdsBefore);
  });
});

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Never rejects, so a racer that fails while the test still parks the others is not lost. */
function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  return work.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );
}

const NOT_STARTED: Promise<Outcome<unknown>> = Promise.resolve({ ok: true, value: null });

function errorCode(outcome: Outcome<unknown>): string | undefined {
  if (outcome.ok || typeof outcome.error !== "object" || outcome.error === null) {
    return undefined;
  }
  return "code" in outcome.error ? String(outcome.error.code) : undefined;
}

/** True once a backend of this database waits on a lock in a statement matching `pattern`. */
async function waitsOnLock(pattern: string): Promise<boolean> {
  const rows = await db().$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
  return (rows[0]?.waiting ?? 0) > 0;
}

/** Returns once the matching statement is parked on a lock: the interleaving is observed. */
async function parkedAt(pattern: string): Promise<void> {
  await expect.poll(() => waitsOnLock(pattern), { timeout: 10_000 }).toBe(true);
}

// The statement each racer parks on, as pg_stat_activity shows it.
const RESET_HOLDS = '%FROM holds%WHERE "eventId"%FOR UPDATE%';
const RESET_ORDERS = '%FROM orders%WHERE "holdId" = ANY%FOR UPDATE%';
const RESET_SEATS = '%FROM seats WHERE "eventId"%FOR UPDATE%';
const PLACE_ORDER_HOLD = "%FROM holds WHERE id = %FOR UPDATE%";
const PLACE_ORDER_SEATS = "%FROM seats WHERE id = ANY%FOR UPDATE%";
const SAGA_SEATS = '%FROM "seats" WHERE "id" = ANY%FOR UPDATE%';
const HOLD_SWEEP_SEATS = `%FROM seats%"holdId" = ANY%'HELD'%FOR UPDATE%`;
const ORDER_SWEEP_SEATS = `%FROM seats%"holdId" = ANY%'IN_CHECKOUT'%FOR UPDATE%`;

const PARKING = { timeout: 20_000 };

/** Holds a row lock on `seatId` while `whileLocked` runs; the lock goes when it returns. */
async function withSeatLocked(seatId: string, whileLocked: () => Promise<void>): Promise<void> {
  await db().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM seats WHERE id = ${seatId}::uuid FOR UPDATE`;
    await whileLocked();
  }, PARKING);
}

// Each test parks the racers in one interleaving with a seat lock and pg_stat_activity, then
// lets them go: no outcome depends on timing.
describe("BookingService.resetEvent racing bookings", () => {
  test("a hold committed after the reset locked the holds blocks the reset, which changes nothing", async () => {
    const event = await demoEvent();
    const early = await service().holdSeats(buyer(), event.id, await freeSeats(event.id, 1));
    const [blocker = "", late = ""] = await freeSeats(event.id, 2);
    let resetting = NOT_STARTED;
    let lateHoldId = "";

    // The reset locks seats in id order and parks on `blocker`: it owns the holds already but not
    // `late`, which a booking then holds and commits.
    await withSeatLocked(blocker, async () => {
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_SEATS);
      lateHoldId = (await service().holdSeats(buyer(), event.id, [late])).id;
    });

    expect(errorCode(await resetting)).toBe("RESET_BLOCKED");
    expect(
      await db().hold.count({ where: { id: { in: [early.id, lateHoldId] }, status: "HELD" } }),
    ).toBe(2);
    expect(
      await db().seat.count({ where: { id: { in: [late, ...early.seatIds] }, status: "HELD" } }),
    ).toBe(2);

    await expect(service().resetEvent(event.id)).resolves.toMatchObject({ holdsDeleted: 2 });
  });

  test("an order placed while the reset waits on its hold is seen, and blocks the reset", async () => {
    const event = await demoEvent();
    const owner = buyer();
    const hold = await service().holdSeats(owner, event.id, await freeSeats(event.id, 1));
    const [seatId = ""] = hold.seatIds;
    let placing = NOT_STARTED;
    let resetting = NOT_STARTED;

    // placeOrder owns the hold and parks on its seat; the reset then parks on that hold.
    await withSeatLocked(seatId, async () => {
      placing = settle(
        service().placeOrder(owner, hold.id, { email: "b@example.com" }, randomUUID()),
      );
      await parkedAt(PLACE_ORDER_SEATS);
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_HOLDS);
    });

    expect((await placing).ok).toBe(true);
    expect(errorCode(await resetting)).toBe("RESET_BLOCKED");
    expect(await db().order.findFirstOrThrow({ where: { holdId: hold.id } })).toMatchObject({
      status: "PENDING_PAYMENT",
    });
    expect(await db().seat.findUniqueOrThrow({ where: { id: seatId } })).toMatchObject({
      status: "IN_CHECKOUT",
      holdId: hold.id,
    });

    await db().order.updateMany({ where: { holdId: hold.id }, data: { status: "EXPIRED" } });
    await service().resetEvent(event.id);
  });

  test("an order placed on a hold the reset already owns finds the hold gone", async () => {
    const event = await demoEvent();
    const owner = buyer();
    const hold = await service().holdSeats(owner, event.id, await freeSeats(event.id, 1));
    const [blocker = ""] = await freeSeats(event.id, 1);
    let placing = NOT_STARTED;
    let resetting = NOT_STARTED;

    // The reset owns the hold and parks on a seat; placeOrder then parks on that hold.
    await withSeatLocked(blocker, async () => {
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_SEATS);
      placing = settle(
        service().placeOrder(owner, hold.id, { email: "b@example.com" }, randomUUID()),
      );
      await parkedAt(PLACE_ORDER_HOLD);
    });

    expect(await resetting).toMatchObject({
      ok: true,
      value: { holdsDeleted: 1, ordersDeleted: 0 },
    });
    expect(errorCode(await placing)).toBe("NOT_FOUND");
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await db().hold.count({ where: { eventId: event.id } })).toBe(0);
  });

  test("the payment saga owning an order the reset waits for: both finish without deadlock", async () => {
    const event = await demoEvent();
    const order = await placedOrder(event.id);
    const [seatId = ""] = order.lines.map((line) => line.seatId);
    const saga = createPaymentSagaHandler({ clock: { now: () => NOW }, newId: randomUUID });
    const paymentId = randomUUID();
    const message = {
      data: JSON.stringify({
        id: randomUUID(),
        type: "payment.succeeded",
        version: 1,
        occurredAt: NOW.toISOString(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
        orderId: order.id,
        payload: {
          paymentId,
          orderId: order.id,
          attemptNo: 1,
          amount: order.totalMinor,
          currency: order.currency,
          capturedAt: NOW.toISOString(),
        },
      }),
    };
    let confirming = NOT_STARTED;
    let resetting = NOT_STARTED;

    // The saga owns the order and parks on its seat; the reset owns the hold and parks on the
    // order. A lock order inversion would close the cycle here and Postgres would abort one.
    await withSeatLocked(seatId, async () => {
      confirming = settle(
        db().$transaction((tx) => saga(tx, message, { emit: async () => undefined }), PARKING),
      );
      await parkedAt(SAGA_SEATS);
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_ORDERS);
    });

    expect(await confirming).toEqual({ ok: true, value: undefined });
    expect(await resetting).toMatchObject({
      ok: true,
      value: { holdsDeleted: 1, ordersDeleted: 1, ledgerRowsDeleted: 1, seatsFreed: 1 },
    });
  });

  test("the hold sweeper owning a hold the reset waits for: both finish without deadlock", async () => {
    const event = await demoEvent();
    const hold = await service().holdSeats(buyer(), event.id, await freeSeats(event.id, 1));
    const [seatId = ""] = hold.seatIds;
    let sweeping = NOT_STARTED;
    let resetting = NOT_STARTED;

    await withSeatLocked(seatId, async () => {
      sweeping = settle(sweeper().sweepExpired());
      await parkedAt(HOLD_SWEEP_SEATS);
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_HOLDS);
    });

    expect(await sweeping).toMatchObject({
      ok: true,
      value: { expiredHoldIds: expect.arrayContaining([hold.id]) },
    });
    expect(await resetting).toMatchObject({
      ok: true,
      value: { holdsDeleted: 1, ordersDeleted: 0, seatsFreed: 0 },
    });
  });

  test("the order sweeper owning an order the reset waits for: both finish without deadlock", async () => {
    const event = await demoEvent();
    const order = await placedOrder(event.id);
    const [seatId = ""] = order.lines.map((line) => line.seatId);
    let sweeping = NOT_STARTED;
    let resetting = NOT_STARTED;

    await withSeatLocked(seatId, async () => {
      sweeping = settle(sweeper().sweepExpired());
      await parkedAt(ORDER_SWEEP_SEATS);
      resetting = settle(service().resetEvent(event.id));
      await parkedAt(RESET_ORDERS);
    });

    expect(await sweeping).toMatchObject({ ok: true, value: { expiredOrderIds: [order.id] } });
    expect(await resetting).toMatchObject({
      ok: true,
      value: { holdsDeleted: 1, ordersDeleted: 1, seatsFreed: 0 },
    });
  });
});
