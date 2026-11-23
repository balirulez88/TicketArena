import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import type { BookingMetric } from "./booking-service";
import {
  bookingTestBed,
  buyer,
  freeSeats,
  type Occupation,
  type OccupyOptions,
  occupy,
  recordingMetrics,
  slowStart,
} from "./testing";

const database = setupTestDatabase();
const { db, open, service } = bookingTestBed(database);

/** Releases the occupation however the work ends, so a failure cannot leave its transaction open. */
async function held<T>(occupation: Occupation, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await occupation.release();
  }
}

describe("BOOKING_BUSY", () => {
  async function expectHoldsRefusedAsBusy(occupyOptions?: OccupyOptions): Promise<void> {
    // One connection and a short wait: concurrent callers queue behind the lock holder below.
    const tight = open({
      poolMax: 1,
      acquireTimeoutMs: 200,
      transaction: { maxWaitMs: 200, timeoutMs: 5000 },
    });
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const recorder = recordingMetrics<BookingMetric>();
    const busy = service({ db: tight, metrics: recorder.metrics });

    // TD-071: the pool is full only once occupy has signalled that its query ran.
    const occupation = await occupy(tight, occupyOptions);

    const outcomes = await held(occupation, () =>
      Promise.all(
        [1, 2, 3].map((n) =>
          busy.holdSeats(buyer(n), eventId, seatIds).then(
            () => "held",
            (error: unknown) =>
              typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : "OTHER",
          ),
        ),
      ),
    );

    expect(outcomes).toEqual(["BOOKING_BUSY", "BOOKING_BUSY", "BOOKING_BUSY"]);
    await expect.poll(() => recorder.count("booking_busy")).toBe(3);
  }

  test("a hold that cannot get a connection or start its transaction in time is retryable BOOKING_BUSY", async () => {
    await expectHoldsRefusedAsBusy();
  });

  test("holds wait for an occupier that is slow to start", async () => {
    await expectHoldsRefusedAsBusy({ beforeStart: slowStart });
  });
});
