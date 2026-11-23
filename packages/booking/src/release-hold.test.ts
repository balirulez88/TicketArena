import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import {
  type Buyer,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
} from "./booking-service";
import { bookingTestBed, freshBuyer, NOW } from "./testing";

const database = setupTestDatabase();
const { db, at, freeSeats, service } = bookingTestBed(database);

const contact = { email: "alice@example.com" };

// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Buyer = freshBuyer();
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

async function heldSeats(count: number) {
  const { eventId, seatIds } = await freeSeats(count);
  const hold = await service().holdSeats(alice, eventId, seatIds);
  return { hold, eventId, seatIds };
}

describe("releaseHold", () => {
  test("marks the hold RELEASED and frees its seats", async () => {
    const { hold, seatIds } = await heldSeats(2);

    const released = await service().releaseHold(alice, hold.id);

    expect(released).toMatchObject({ id: hold.id, status: "RELEASED", seatIds });
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "RELEASED" });
    const seats = await db().seat.findMany({ where: { id: { in: seatIds } } });
    expect(seats.map((seat) => [seat.status, seat.holdId, seat.claimBuyerKey])).toEqual([
      ["AVAILABLE", null, null],
      ["AVAILABLE", null, null],
    ]);
  });

  test("writes one hold.released outbox event with the hold's correlationId", async () => {
    const { hold, seatIds } = await heldSeats(1);

    await service().releaseHold(alice, hold.id);

    const events = await db().outboxEvent.findMany({
      where: { aggregateId: hold.id, eventType: "hold.released" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: "hold",
      payload: {
        type: "hold.released",
        version: 1,
        correlationId: hold.correlationId,
        causationId: null,
        holdId: hold.id,
        occurredAt: NOW.toISOString(),
        payload: { holdId: hold.id, seatIds },
      },
    });
  });

  test("frees only the seats that still carry this hold's id", async () => {
    const { hold, seatIds } = await heldSeats(2);
    const [kept, takenOver] = seatIds;
    if (kept === undefined || takenOver === undefined) {
      throw new Error("demo event needs two available seats");
    }
    // Simulates a lazy takeover: the seat already belongs to another hold.
    const other = await service().holdSeats(bob, hold.eventId, [
      (await freeSeats(1, { eventId: hold.eventId })).seatIds[0] ?? "",
    ]);
    await db().seat.update({ where: { id: takenOver }, data: { holdId: other.id } });

    const released = await service().releaseHold(alice, hold.id);

    expect(released.seatIds).toEqual([kept]);
    const seat = await db().seat.findUniqueOrThrow({ where: { id: takenOver } });
    expect(seat).toMatchObject({ status: "HELD", holdId: other.id });
  });

  test("lets another buyer hold the released seats immediately", async () => {
    const { hold, eventId, seatIds } = await heldSeats(2);

    await service().releaseHold(alice, hold.id);
    const bobs = await service().holdSeats(bob, eventId, seatIds);

    expect(bobs).toMatchObject({ status: "HELD", seatIds });
  });

  test("hides the hold from anyone but its owner and changes nothing", async () => {
    const { hold, seatIds } = await heldSeats(1);

    await expect(service().releaseHold(bob, hold.id)).rejects.toBeInstanceOf(HoldNotFoundError);
    await expect(service().releaseHold(alice, randomUUID())).rejects.toBeInstanceOf(
      HoldNotFoundError,
    );
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "HELD", seatIds });
  });

  test("refuses a hold that is no longer HELD", async () => {
    const released = await heldSeats(1);
    await service().releaseHold(alice, released.hold.id);
    const ordered = await heldSeats(1);
    await service().placeOrder(alice, ordered.hold.id, contact, randomUUID());

    await expect(service().releaseHold(alice, released.hold.id)).rejects.toBeInstanceOf(
      HoldNotActiveError,
    );
    await expect(service().releaseHold(alice, ordered.hold.id)).rejects.toBeInstanceOf(
      HoldNotActiveError,
    );
    const seats = await db().seat.findMany({ where: { id: { in: ordered.seatIds } } });
    expect(seats.map((seat) => seat.status)).toEqual(["IN_CHECKOUT"]);
    expect(
      await db().outboxEvent.count({
        where: { aggregateId: released.hold.id, eventType: "hold.released" },
      }),
    ).toBe(1);
  });

  test("concurrent releases of one hold release it exactly once", async () => {
    const { hold } = await heldSeats(1);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => service().releaseHold(alice, hold.id)),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      await db().outboxEvent.count({ where: { aggregateId: hold.id, eventType: "hold.released" } }),
    ).toBe(1);
  });

  test("refuses an expired hold the sweeper has not reached with HOLD_EXPIRED and changes nothing", async () => {
    const { hold, seatIds } = await heldSeats(2);

    await expect(at(hold.holdExpiresAt).releaseHold(alice, hold.id)).rejects.toBeInstanceOf(
      HoldExpiredError,
    );

    // Left HELD for the sweeper, which frees the seats and writes hold.expired.
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "HELD", seatIds });
    const seats = await db().seat.findMany({ where: { id: { in: seatIds } } });
    expect(seats.map((seat) => [seat.status, seat.holdId])).toEqual([
      ["HELD", hold.id],
      ["HELD", hold.id],
    ]);
    expect(
      await db().outboxEvent.count({ where: { aggregateId: hold.id, eventType: "hold.released" } }),
    ).toBe(0);
  });

  test("refuses a hold the sweeper already expired with HOLD_EXPIRED", async () => {
    const { hold } = await heldSeats(1);
    await at(hold.holdExpiresAt).sweepExpired();

    await expect(
      at(new Date(hold.holdExpiresAt.getTime() + 1)).releaseHold(alice, hold.id),
    ).rejects.toBeInstanceOf(HoldExpiredError);
    expect(await service().getHold(alice, hold.id)).toMatchObject({ status: "EXPIRED" });
  });

  test("releases a hold one millisecond before holdExpiresAt", async () => {
    const { hold, seatIds } = await heldSeats(1);

    const released = await at(new Date(hold.holdExpiresAt.getTime() - 1)).releaseHold(
      alice,
      hold.id,
    );

    expect(released).toMatchObject({ id: hold.id, status: "RELEASED", seatIds });
  });
});
