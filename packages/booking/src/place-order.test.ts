import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  HoldSeatSetMissingError,
  IdempotencyKeyReusedError,
  MixedCurrencyError,
  type OrderView,
  requestHash,
  SeatUnavailableError,
} from "./booking-service";
import {
  block,
  bookingTestBed,
  failureOf,
  freshBuyer,
  NOW,
  rowLock,
  waitUntilBlocked,
} from "./testing";

const database = setupTestDatabase();
const { db, service, at, freeSeats } = bookingTestBed(database);

// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
});
const contact = { email: "alice@example.com" };

async function heldSeat() {
  const { eventId, seatIds } = await freeSeats(1);
  const hold = await service().holdSeats(alice, eventId, seatIds);
  return { hold, seatId: seatIds[0] ?? "" };
}

describe("requestHash", () => {
  const holdId = "6f1c1f43-5e0a-4a43-9d0e-4a3c6f2b1a10";

  test("depends only on the canonical request: hold id, email and phone", () => {
    const base = requestHash(holdId, { email: "alice@example.com", phone: "+3612345" });

    expect(requestHash(holdId, { phone: "+3612345", email: "alice@example.com" })).toBe(base);
    expect(requestHash(holdId, { email: "alice@example.com" })).toBe(
      requestHash(holdId, { email: "alice@example.com", phone: undefined }),
    );
    expect(requestHash(randomUUID(), { email: "alice@example.com", phone: "+3612345" })).not.toBe(
      base,
    );
    expect(requestHash(holdId, { email: "bob@example.com", phone: "+3612345" })).not.toBe(base);
    expect(requestHash(holdId, { email: "alice@example.com", phone: "+3699999" })).not.toBe(base);
    expect(requestHash(holdId, { email: "alice@example.com" })).not.toBe(base);
  });
});

describe("placeOrder", () => {
  test("turns a valid hold into a PENDING_PAYMENT order due 5 minutes after the clock reading", async () => {
    const { hold, seatId } = await heldSeat();
    const placedAt = new Date("2027-03-01T12:02:00.000Z");

    const order = await at(placedAt).placeOrder(alice, hold.id, contact, randomUUID());

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

  test("AT-12: returns the same order for a repeated idempotencyKey, even after the hold expired", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();
    const first = await service().placeOrder(alice, hold.id, contact, key);

    const replay = await at(new Date("2027-03-01T13:00:00.000Z")).placeOrder(
      alice,
      hold.id,
      { phone: undefined, ...contact },
      key,
    );

    expect(replay).toEqual(first);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(1);
    expect(await db().outboxEvent.count({ where: { aggregateId: first.id } })).toBe(1);
  });

  test("AT-12: concurrent duplicates yield one order, one set of lines and one order.placed event", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();

    const orders = await Promise.all(
      Array.from({ length: 5 }, () => service().placeOrder(alice, hold.id, contact, key)),
    );

    const [first] = orders;
    if (first === undefined) {
      throw new Error("no order returned");
    }
    expect(new Set(orders.map((order) => order.id))).toEqual(new Set([first.id]));
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(1);
    expect(await db().orderLine.count({ where: { order: { holdId: hold.id } } })).toBe(1);
    expect(
      await db().outboxEvent.count({
        where: { eventType: "order.placed", payload: { path: ["holdId"], equals: hold.id } },
      }),
    ).toBe(1);
    expect(await db().outboxEvent.count({ where: { aggregateId: first.id } })).toBe(1);
  });

  test("AT-13: rejects a reused key carrying a different contact", async () => {
    const { hold } = await heldSeat();
    const key = randomUUID();
    await service().placeOrder(alice, hold.id, contact, key);

    await expect(
      service().placeOrder(alice, hold.id, { email: "other@example.com" }, key),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    await expect(
      service().placeOrder(alice, hold.id, { ...contact, phone: "+3612345" }, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("AT-13: rejects a reused key carrying a different hold and leaves that hold untouched", async () => {
    const first = await heldSeat();
    const key = randomUUID();
    await service().placeOrder(alice, first.hold.id, contact, key);
    const second = await heldSeat();

    await expect(service().placeOrder(alice, second.hold.id, contact, key)).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    expect(await db().order.count({ where: { holdId: second.hold.id } })).toBe(0);
    expect(await service().getHold(alice, second.hold.id)).toMatchObject({ status: "HELD" });
  });

  test("a duplicate that loses the unique-constraint race re-reads and returns the winner's order", async () => {
    const { hold, seatId } = await heldSeat();
    const other = await heldSeat();
    const key = randomUUID();
    const winnerId = randomUUID();
    // Holding the seat lock parks the loser after its in-transaction duplicate check; on release
    // the blocker first commits the winner: the same (sessionId, idempotencyKey) and request hash.
    // It references another hold so its foreign-key check does not wait on the loser.
    const blocker = await block(db(), rowLock("seats", [seatId]), {
      what: "the seat lock",
      afterRelease: (tx) =>
        tx.order.create({
          data: {
            id: winnerId,
            holdId: other.hold.id,
            sessionId: alice.sessionId,
            buyerKey: alice.buyerKey,
            contactEmail: contact.email,
            totalMinor: 0,
            currency: "EUR",
            paymentDeadline: NOW,
            idempotencyKey: key,
            requestHash: requestHash(hold.id, contact),
            correlationId: other.hold.correlationId,
            createdAt: NOW,
          },
        }),
    });
    const loser: Promise<OrderView> = service().placeOrder(alice, hold.id, contact, key);
    try {
      await waitUntilBlocked(db(), blocker.pid, {
        what: "the losing placeOrder waiting on the seat lock",
        against: loser,
      });
    } finally {
      await blocker.release();
    }
    const order = await loser;

    expect(order.id).toBe(winnerId);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "HELD" });
    expect(
      await db().outboxEvent.count({
        where: { eventType: "order.placed", payload: { path: ["holdId"], equals: hold.id } },
      }),
    ).toBe(0);
  });

  test("hides a hold from anyone but its owner", async () => {
    const { hold } = await heldSeat();
    const bob = freshBuyer();

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
      at(hold.holdExpiresAt).placeOrder(alice, hold.id, contact, randomUUID()),
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
    const bob = freshBuyer();

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

  // As for holdSeats (TD-016): every clock read is stamped, synchronously, with a flag the
  // blocker sets only after Postgres shows placeOrder waiting on its lock, immediately before it
  // commits. A read taken before that lock is granted happens before the flag.
  test.each(["holds", "seats"] as const)(
    "reads the clock only after the hold and its seats are locked: after the %s lock",
    async (table) => {
      const { hold, seatId } = await heldSeat();
      let committing = false;
      const reads: boolean[] = [];
      const clock = {
        now: () => {
          reads.push(committing);
          return NOW;
        },
      };
      const blocker = await block(db(), rowLock(table, [table === "holds" ? hold.id : seatId]), {
        what: `the ${table} lock`,
      });
      const placing = service({ clock }).placeOrder(alice, hold.id, contact, randomUUID());
      try {
        await waitUntilBlocked(db(), blocker.pid, {
          what: `placeOrder waiting on the ${table} lock`,
          against: placing,
        });
      } finally {
        committing = true;
        await blocker.release();
      }
      await placing;

      expect(reads.length).toBeGreaterThan(0);
      expect(reads).toEqual(reads.map(() => true));
    },
  );

  test("locks the hold before the seats", async () => {
    const { hold, seatId } = await heldSeat();
    const blocker = await block(db(), rowLock("seats", [seatId]), { what: "the seat lock" });
    const started = service().placeOrder(alice, hold.id, contact, randomUUID());
    try {
      // placeOrder now waits on the seat lock; it must already own the hold lock.
      await waitUntilBlocked(db(), blocker.pid, {
        what: "placeOrder waiting on the seat lock",
        against: started,
      });
      expect(await isLocked("holds", hold.id)).toBe(true);
    } finally {
      await blocker.release();
    }
    await expect(started).resolves.toBeDefined();
  });

  // TD-018: the order.placed row is the last write. Its envelope id comes from newId; a fixed
  // newId returning the id of the hold's own seat.held row makes that insert fail after the order,
  // hold and seat writes. One seat, so the order's single line can take that id too.
  test("a failure after the writes have begun leaves no order, the hold HELD and its seats unchanged", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);
    const [held] = await db().outboxEvent.findMany({ where: { aggregateId: hold.id } });
    if (held === undefined) {
      throw new Error("the hold wrote no seat.held row");
    }
    const seatsBefore = await db().seat.findMany({
      where: { id: { in: seatIds } },
      orderBy: { id: "asc" },
    });

    const failure = await failureOf(
      service({ newId: () => held.id }).placeOrder(alice, hold.id, contact, randomUUID()),
    );

    expect(failure).toMatchObject({ code: "P2002", meta: { modelName: "OutboxEvent" } });
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    expect(await db().order.count({ where: { id: held.id } })).toBe(0);
    expect(
      await db().outboxEvent.count({
        where: { eventType: "order.placed", payload: { path: ["holdId"], equals: hold.id } },
      }),
    ).toBe(0);
    expect((await db().hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("HELD");
    expect(
      await db().seat.findMany({ where: { id: { in: seatIds } }, orderBy: { id: "asc" } }),
    ).toEqual(seatsBefore);
  });

  test("refuses when a held seat lost its holdId", async () => {
    const { hold, seatId } = await heldSeat();
    await db().seat.update({ where: { id: seatId }, data: { holdId: null } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
  });

  test("neither prices nor mutates a seat that carries the hold's id but is outside its seat.held set", async () => {
    const { hold, seatId } = await heldSeat();
    const stray = await db().seat.findFirstOrThrow({
      where: { eventId: hold.eventId, status: "AVAILABLE", id: { not: seatId } },
      orderBy: { id: "asc" },
    });
    await db().seat.update({
      where: { id: stray.id },
      data: { status: "HELD", holdId: hold.id, claimBuyerKey: alice.buyerKey },
    });

    const order = await service().placeOrder(alice, hold.id, contact, randomUUID());

    expect(order.lines.map((line) => line.seatId)).toEqual([seatId]);
    const priced = await db().seat.findUniqueOrThrow({
      where: { id: seatId },
      include: { row: { include: { section: true } } },
    });
    expect(order.totalMinor).toBe(priced.row.section.priceMinor);
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "IN_CHECKOUT",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: stray.id } })).status).toBe("HELD");
  });

  test("refuses a hold that is not HELD before reading its seat.held event", async () => {
    const { hold } = await heldSeat();
    await db().outboxEvent.deleteMany({ where: { aggregateId: hold.id } });
    await db().hold.update({ where: { id: hold.id }, data: { status: "RELEASED" } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldNotActiveError);
  });

  test("a HELD hold whose seat.held event is gone is a domain error", async () => {
    const { hold } = await heldSeat();
    await db().outboxEvent.deleteMany({ where: { aggregateId: hold.id } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(HoldSeatSetMissingError);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
  });

  test("fails with a domain error when the held seats are priced in different currencies", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const sections = await db().section.findMany({
      where: { rows: { some: { seats: { some: { eventId: event.id, status: "AVAILABLE" } } } } },
      orderBy: { id: "asc" },
    });
    const [first, second] = sections;
    if (first === undefined || second === undefined) {
      throw new Error("seed needs two sections with available seats");
    }
    const seatIn = (sectionId: string) =>
      db().seat.findFirstOrThrow({
        where: { eventId: event.id, status: "AVAILABLE", row: { sectionId } },
        orderBy: { id: "asc" },
      });
    const a = await seatIn(first.id);
    const b = await seatIn(second.id);
    const hold = await service().holdSeats(alice, event.id, [a.id, b.id]);
    await db().section.update({ where: { id: second.id }, data: { currency: "USD" } });

    try {
      await expect(
        service().placeOrder(alice, hold.id, contact, randomUUID()),
      ).rejects.toBeInstanceOf(MixedCurrencyError);
      expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
    } finally {
      await db().section.update({ where: { id: second.id }, data: { currency: first.currency } });
    }
  });

  test("refuses when a seat of the hold is no longer HELD", async () => {
    const { hold, seatId } = await heldSeat();
    await db().seat.update({ where: { id: seatId }, data: { status: "AVAILABLE" } });

    await expect(
      service().placeOrder(alice, hold.id, contact, randomUUID()),
    ).rejects.toBeInstanceOf(SeatUnavailableError);
  });
});
