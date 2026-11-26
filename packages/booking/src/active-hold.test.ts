import { randomUUID } from "node:crypto";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeEach, describe, expect, test } from "vitest";
import type { Buyer } from "./booking-service";
import { bookingTestBed, freshBuyer, NOW } from "./testing";

const database = setupTestDatabase();
const { db, at, freeSeats, service } = bookingTestBed(database);

// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Buyer = freshBuyer();
let bob: Buyer = freshBuyer();

beforeEach(() => {
  alice = freshBuyer();
  bob = freshBuyer();
});

async function priceOf(seatId: string) {
  const seat = await db().seat.findUniqueOrThrow({
    where: { id: seatId },
    select: { row: { select: { section: { select: { priceMinor: true, currency: true } } } } },
  });
  return { id: seatId, ...seat.row.section };
}

describe("activeHold", () => {
  test("returns the session's live hold for the event with its seats priced", async () => {
    const { eventId, seatIds } = await freeSeats(2);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    const active = await service().activeHold(alice, eventId);

    expect(active).toEqual({
      ...hold,
      seats: await Promise.all(seatIds.map(priceOf)),
    });
  });

  test("is null when the session holds nothing for the event", async () => {
    const { eventId } = await freeSeats(1);

    expect(await service().activeHold(alice, eventId)).toBeNull();
  });

  test("never returns another session's hold", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    await service().holdSeats(bob, eventId, seatIds);

    expect(await service().activeHold(alice, eventId)).toBeNull();
  });

  test("never returns a hold of another session of the same signed-in user", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const userId = randomUUID();
    const laptop: Buyer = { sessionId: randomUUID(), userId, buyerKey: userId };
    const phone: Buyer = { sessionId: randomUUID(), userId, buyerKey: userId };
    await service().holdSeats(laptop, eventId, seatIds);

    expect(await service().activeHold(phone, eventId)).toBeNull();
  });

  test("is null for a hold of another event", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    await service().holdSeats(alice, eventId, seatIds);

    expect(await service().activeHold(alice, randomUUID())).toBeNull();
  });

  test("is null once the hold is expired, even before the sweeper runs", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);

    const justBefore = new Date(hold.holdExpiresAt.getTime() - 1);
    expect(await at(justBefore).activeHold(alice, eventId)).toMatchObject({ id: hold.id });
    expect(await at(hold.holdExpiresAt).activeHold(alice, eventId)).toBeNull();
    expect(await db().hold.findUnique({ where: { id: hold.id } })).toMatchObject({
      status: "HELD",
    });
  });

  test("is null once the hold is released", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);
    await service().releaseHold(alice, hold.id);

    expect(await service().activeHold(alice, eventId)).toBeNull();
  });

  test("is null once the hold is swept", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);
    await at(hold.holdExpiresAt).sweepExpired();

    expect(await service().activeHold(alice, eventId)).toBeNull();
  });

  test("is null once the hold became an order", async () => {
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await service().holdSeats(alice, eventId, seatIds);
    await service().placeOrder(alice, hold.id, { email: "alice@example.com" }, randomUUID());

    expect(await service().activeHold(alice, eventId)).toBeNull();
  });

  test("returns the latest of several live holds", async () => {
    const { eventId, seatIds } = await freeSeats(2);
    const [first, second] = seatIds;
    if (first === undefined || second === undefined) {
      throw new Error("demo event needs two available seats");
    }
    await service().holdSeats(alice, eventId, [first]);
    const later = await at(new Date(NOW.getTime() + 1000)).holdSeats(alice, eventId, [second]);

    expect(await at(new Date(NOW.getTime() + 2000)).activeHold(alice, eventId)).toMatchObject({
      id: later.id,
      seatIds: [second],
    });
  });
});
