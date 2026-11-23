import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { bookingTestBed, buyer } from "./testing";

const database = setupTestDatabase();
const { db, freeSeats, service } = bookingTestBed(database);

const MAX_SEATS_PER_HOLD = 6;

describe("holdSeats seat count", () => {
  test("holds all six seats of a full selection in one action", async () => {
    const { eventId, seatIds } = await freeSeats(MAX_SEATS_PER_HOLD);
    const hold = await service().holdSeats(buyer(1), eventId, seatIds);
    expect(hold.status).toBe("HELD");
    expect([...hold.seatIds].sort()).toEqual([...seatIds].sort());
  });

  test("refuses a seventh seat without holding any of them", async () => {
    const { eventId, seatIds } = await freeSeats(MAX_SEATS_PER_HOLD + 1);
    await expect(service().holdSeats(buyer(2), eventId, seatIds)).rejects.toMatchObject({
      code: "INVALID_SEAT_SELECTION",
    });
    expect(await db().seat.count({ where: { id: { in: seatIds }, status: "HELD" } })).toBe(0);
  });
});
