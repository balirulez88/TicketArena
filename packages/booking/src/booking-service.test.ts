import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  InvalidSeatSelectionError,
  NotOnSaleError,
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
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

describe("holdSeats", () => {
  test("holds an available seat for 10 minutes after the clock reading", async () => {
    const { eventId, seatIds } = await freeSeats(1);

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
    const { eventId, seatIds } = await freeSeats(1);

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
    const { eventId, seatIds } = await freeSeats(2);

    const first = await service().holdSeats(alice, eventId, [seatIds[0] ?? ""]);
    const second = await service().holdSeats(alice, eventId, [seatIds[1] ?? ""]);

    expect(first.correlationId).not.toBe(second.correlationId);
  });

  test("a held seat is SEAT_UNAVAILABLE naming its id, and nothing is written", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    await service().holdSeats(alice, eventId, seatIds);
    const holdsBefore = await db().hold.count();
    const outboxBefore = await db().outboxEvent.count();

    const failure = await failureOf(service().holdSeats(bob, eventId, seatIds));

    expect(failure).toBeInstanceOf(SeatUnavailableError);
    expect(failure).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds });
    expect(await db().hold.count()).toBe(holdsBefore);
    expect(await db().outboxEvent.count()).toBe(outboxBefore);
  });

  test("before the event's onSaleAt is NOT_ON_SALE and changes nothing; 1 ms after it, the hold succeeds", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: false } });
    const { seatIds } = await freeSeats(1, { eventId: event.id });
    const seat = { id: seatIds[0] ?? "" };
    const holdsBefore = await db().hold.count();
    const outboxBefore = await db().outboxEvent.count();
    const onSaleAt = event.onSaleAt.getTime();

    const failure = await failureOf(
      at(new Date(onSaleAt - 1)).holdSeats(alice, event.id, [seat.id]),
    );

    expect(failure).toBeInstanceOf(NotOnSaleError);
    expect(failure).toMatchObject({ code: "NOT_ON_SALE", onSaleAt: event.onSaleAt });
    expect(await db().hold.count()).toBe(holdsBefore);
    expect(await db().outboxEvent.count()).toBe(outboxBefore);
    expect((await db().seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe(
      "AVAILABLE",
    );

    const hold = await at(new Date(onSaleAt + 1)).holdSeats(alice, event.id, [seat.id]);
    expect(hold).toMatchObject({ status: "HELD", seatIds: [seat.id] });
  });

  test("a seat of another event is SEAT_UNAVAILABLE", async () => {
    const { seatIds } = await freeSeats(1);
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });
    // After the other event's on-sale, so only the seat's event can refuse the hold.
    const onSale = new Date(other.onSaleAt.getTime() + 1);

    await expect(at(onSale).holdSeats(alice, other.id, seatIds)).rejects.toMatchObject({
      code: "SEAT_UNAVAILABLE",
      seatIds,
    });
  });

  test("two concurrent holds of one seat: exactly one wins", async () => {
    const { eventId, seatIds } = await freeSeats(1);

    const results = await Promise.allSettled([
      service().holdSeats(alice, eventId, seatIds),
      service().holdSeats(bob, eventId, seatIds),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [loser] = results.filter((result) => result.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(SeatUnavailableError);
  });

  test("reads the clock after taking the seat lock", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    // The reads up to and including the lock-free snapshot: those of a call the snapshot refuses.
    const refused = await freeSeats(1, { order: "desc" });
    await db().seat.updateMany({
      where: { id: { in: refused.seatIds } },
      data: { status: "SOLD" },
    });
    let snapshotReads = 0;
    const counting = {
      now: () => {
        snapshotReads += 1;
        return NOW;
      },
    };
    expect(
      await failureOf(service({ clock: counting }).holdSeats(bob, eventId, refused.seatIds)),
    ).toBeInstanceOf(SeatUnavailableError);
    // TD-016: each read is stamped, synchronously, with whether the blocker had already been seen
    // blocking the service and was about to commit. That is sound: the blocker sets the flag only
    // after pg_blocking_pids shows the service waiting on its seat lock, and immediately before it
    // sends COMMIT. A read taken before the lock happens before the service blocks, so before the
    // flag; a read taken after the lock happens after the blocker commits, so after the flag.
    let committing = false;
    const reads: boolean[] = [];
    const clock = {
      now: () => {
        reads.push(committing);
        return NOW;
      },
    };
    const blocker = await block(db(), rowLock("seats", seatIds), { what: "the seat lock" });
    const call = service({ clock }).holdSeats(alice, eventId, seatIds);
    try {
      await waitUntilBlocked(db(), blocker.pid, {
        what: "holdSeats waiting on the seat lock",
        against: call,
      });
    } finally {
      committing = true;
      await blocker.release();
    }
    await call;

    const afterSnapshot = reads.slice(snapshotReads);
    expect(snapshotReads).toBeGreaterThan(0);
    expect(afterSnapshot.length).toBeGreaterThan(0);
    expect(afterSnapshot).toEqual(afterSnapshot.map(() => true));
  });

  // TD-018: the outbox row is the last write. Its envelope id comes from newId; a fixed newId that
  // returns the id of an existing outbox row makes that insert fail after the hold and seat writes.
  test("a failure after the writes have begun leaves no hold, no claim, every seat AVAILABLE and no outbox row", async () => {
    const first = await freeSeats(1);
    const earlier = await service().holdSeats(bob, first.eventId, first.seatIds);
    const [taken] = await db().outboxEvent.findMany({ where: { aggregateId: earlier.id } });
    if (taken === undefined) {
      throw new Error("the earlier hold wrote no outbox row");
    }
    const { eventId, seatIds } = await freeSeats(2);

    const failure = await failureOf(
      service({ newId: () => taken.id }).holdSeats(alice, eventId, seatIds),
    );

    expect(failure).toMatchObject({ code: "P2002", meta: { modelName: "OutboxEvent" } });
    expect(await db().hold.count({ where: { buyerKey: alice.buyerKey } })).toBe(0);
    expect(await db().hold.count({ where: { id: taken.id } })).toBe(0);
    expect(
      await db().seat.findMany({
        where: { id: { in: seatIds } },
        select: { status: true, holdId: true, claimBuyerKey: true },
      }),
    ).toEqual(seatIds.map(() => ({ status: "AVAILABLE", holdId: null, claimBuyerKey: null })));
    expect(await db().outboxEvent.count({ where: { aggregateId: taken.id } })).toBe(0);
  });
});

describe("holdSeats seat selection", () => {
  test("rejects an empty seatIds list before writing anything", async () => {
    const { eventId } = await freeSeats(1);
    const before = await db().hold.count();

    await expect(service().holdSeats(alice, eventId, [])).rejects.toBeInstanceOf(
      InvalidSeatSelectionError,
    );
    expect(await db().hold.count()).toBe(before);
  });

  test("rejects a duplicated seatIds list before writing anything", async () => {
    const { eventId, seatIds } = await freeSeats(1);
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
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(alice, hold.id)).toEqual(hold);
  });

  test("returns null to another buyer and for an unknown id", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    expect(await service().getHold(bob, hold.id)).toBeNull();
    expect(await service().getHold(alice, randomUUID())).toBeNull();
  });
});
