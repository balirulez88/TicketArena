import { randomUUID } from "node:crypto";
import type { TransactionClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import type { BookingMetric } from "./booking-service";
import {
  block,
  bookingTestBed,
  freshBuyer,
  NOW,
  recordingMetrics,
  rowLock,
  settledUnlessBlocked,
  waitUntilBlocked,
} from "./testing";

const database = setupTestDatabase();
const { db, at, freeSeats, service } = bookingTestBed(database);

const LATER = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);

/** On release, the blocker first sells the seat, in its own transaction. */
function sells(seatId: string) {
  return {
    afterRelease: (tx: TransactionClient) =>
      tx.seat.update({ where: { id: seatId }, data: { status: "SOLD" } }),
  };
}

describe("holdSeats snapshot fast path", () => {
  test.each(["SOLD", "IN_CHECKOUT"] as const)(
    "a %s seat is SEAT_UNAVAILABLE without waiting on a lock held by another transaction",
    async (status) => {
      const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
      const seatId = seatIds[0] ?? "";
      await db().seat.update({ where: { id: seatId }, data: { status } });
      const lock = await block(db(), rowLock("seats", [seatId]), { what: "the seat lock" });

      try {
        const outcome = await settledUnlessBlocked(
          db(),
          lock.pid,
          service().holdSeats(freshBuyer(), eventId, [seatId]),
        );

        expect(outcome).not.toBe("blocked");
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { code: "SEAT_UNAVAILABLE", seatIds: [seatId] },
        });
      } finally {
        await lock.release();
      }
    },
  );
});

describe("holdSeats HELD seats and expiry", () => {
  test("an unexpired HELD seat is SEAT_UNAVAILABLE without waiting on a lock", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    await service().holdSeats(freshBuyer(), eventId, [seatId]);
    const lock = await block(db(), rowLock("seats", [seatId]), { what: "the seat lock" });
    try {
      const outcome = await settledUnlessBlocked(
        db(),
        lock.pid,
        service().holdSeats(freshBuyer(), eventId, [seatId]),
      );
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: { code: "SEAT_UNAVAILABLE", seatIds: [seatId] },
      });
    } finally {
      await lock.release();
    }
  });

  test("an expired HELD seat is not refused by the snapshot: the call goes on to wait for the lock", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    await service().holdSeats(freshBuyer(), eventId, [seatId]);
    const lock = await block(db(), rowLock("seats", [seatId]), { what: "the seat lock" });
    const call = at(LATER).holdSeats(freshBuyer(), eventId, [seatId]);
    try {
      expect(await settledUnlessBlocked(db(), lock.pid, call)).toBe("blocked");
    } finally {
      await lock.release();
      await call.catch(() => undefined);
    }
  });
});

describe("holdSeats metrics on the fast path and the race", () => {
  test("a snapshot refusal counts seat_unavailable only, without waiting on metrics", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    await db().seat.update({ where: { id: seatId }, data: { status: "SOLD" } });
    const recorder = recordingMetrics<BookingMetric>({ settles: false });
    await expect(
      service({ metrics: recorder.metrics }).holdSeats(freshBuyer(), eventId, [seatId]),
    ).rejects.toMatchObject({ code: "SEAT_UNAVAILABLE" });
    expect(recorder.names()).toEqual(["seat_unavailable"]);
  });

  test("a seat taken between snapshot and lock counts race_lost only", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    const lock = await block(db(), rowLock("seats", [seatId]), {
      what: "the seat lock",
      ...sells(seatId),
    });
    const recorder = recordingMetrics<BookingMetric>({ settles: false });
    const settled = service({ metrics: recorder.metrics })
      .holdSeats(freshBuyer(), eventId, [seatId])
      .then(
        () => "held" as const,
        (error: unknown) => error,
      );
    try {
      // holdSeats reads its lock-free snapshot before it opens the locking transaction, so once
      // it waits here the snapshot has seen the seat as it was before the release changes it.
      await waitUntilBlocked(db(), lock.pid, {
        what: "holdSeats waiting on the seat lock",
        against: settled,
      });
    } finally {
      await lock.release();
    }
    expect(await settled).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [seatId] });
    expect(recorder.names()).toEqual(["race_lost"]);
  });

  // Lazy expiry (TD-013): the snapshot and the locked step agree that an expired hold frees its
  // seat, so the call wins and no refusal is counted.
  test("an expired HELD seat is held under the lock and counts hold_ok only", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    await service().holdSeats(freshBuyer(), eventId, [seatId]);
    const recorder = recordingMetrics<BookingMetric>({ settles: false });
    await expect(
      at(LATER, { metrics: recorder.metrics }).holdSeats(freshBuyer(), eventId, [seatId]),
    ).resolves.toMatchObject({ status: "HELD" });
    expect(recorder.names()).toEqual(["hold_ok"]);
  });

  test("an expired HELD seat taken between snapshot and lock counts race_lost only", async () => {
    const { eventId, seatIds } = await freeSeats(1, { order: "desc" });
    const seatId = seatIds[0] ?? "";
    await service().holdSeats(freshBuyer(), eventId, [seatId]);
    const lock = await block(db(), rowLock("seats", [seatId]), {
      what: "the seat lock",
      ...sells(seatId),
    });
    const recorder = recordingMetrics<BookingMetric>({ settles: false });
    const settled = at(LATER, { metrics: recorder.metrics })
      .holdSeats(freshBuyer(), eventId, [seatId])
      .then(
        () => "held" as const,
        (error: unknown) => error,
      );
    try {
      await waitUntilBlocked(db(), lock.pid, {
        what: "holdSeats waiting on the seat lock",
        against: settled,
      });
    } finally {
      await lock.release();
    }
    expect(await settled).toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [seatId] });
    expect(recorder.names()).toEqual(["race_lost"]);
  });

  test("an unknown seat id counts seat_unavailable, not race_lost", async () => {
    const { eventId } = await freeSeats(1, { order: "desc" });
    const unknownSeatId = randomUUID();
    const recorder = recordingMetrics<BookingMetric>({ settles: false });
    await expect(
      service({ metrics: recorder.metrics }).holdSeats(freshBuyer(), eventId, [unknownSeatId]),
    ).rejects.toMatchObject({ code: "SEAT_UNAVAILABLE", seatIds: [unknownSeatId] });
    expect(recorder.names()).toEqual(["seat_unavailable"]);
  });
});
