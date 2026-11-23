import { randomUUID } from "node:crypto";
import type { Logger } from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { expect, test } from "vitest";
import { type BookingMetric, createBookingService } from "./booking-service";
import { type BookingTimeouts, bookingTransactionOptions } from "./booking-transaction";
import {
  type Blocker,
  block,
  blockedBy,
  bookingTestBed,
  buyerLock,
  freeSeats,
  freshBuyer,
  NOW,
  recordingMetrics,
  rowLock,
  waitForPg,
} from "./testing";

const database = setupTestDatabase();
const { open } = bookingTestBed(database);

test("one placeOrder attempt waits on each of its three locks in turn and commits within the budget", async () => {
  // Shortened, but lock_timeout stays at least 1 s so 60% of it is a real wait.
  const timeouts: BookingTimeouts = { lockTimeoutMs: 1_500, statementTimeoutMs: 3_000, retries: 3 };
  const mustWaitMs = 0.6 * timeouts.lockTimeoutMs;
  const db = open({ transaction: bookingTransactionOptions(timeouts) });
  const sessions = open();

  const buyer = freshBuyer();
  const { eventId, seatIds } = await freeSeats(db, 2);
  const recorder = recordingMetrics<BookingMetric>();
  const retried: unknown[] = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (fields, message) => {
      if (message === "booking transaction retried" && "sqlState" in fields) {
        retried.push(fields.sqlState);
      }
    },
    error: () => undefined,
    child: () => logger,
  };
  const booking = createBookingService({
    db,
    clock: { now: () => NOW },
    newId: randomUUID,
    logger,
    timeouts,
    delay: () => Promise.resolve(),
    metrics: recorder.metrics,
  });
  const hold = await booking.holdSeats(buyer, eventId, seatIds);

  // placeOrder's lock order (ADR 0005): buyer advisory lock, hold row, seat rows.
  const locks: { readonly name: string; take(tx: TransactionClient): Promise<unknown> }[] = [
    { name: "buyer advisory lock", take: buyerLock(eventId, buyer.buyerKey) },
    { name: "hold row", take: rowLock("holds", [hold.id]) },
    { name: "seat rows", take: rowLock("seats", seatIds) },
  ];
  const blockers: Blocker[] = [];
  for (const lock of locks) {
    blockers.push(await block(sessions, lock.take, { what: `the ${lock.name}` }));
  }
  const observed: string[] = [];
  try {
    const call = booking.placeOrder(buyer, hold.id, { email: "b@example.com" }, randomUUID());
    call.catch(() => undefined);
    for (const [index, lock] of locks.entries()) {
      const blocker = blockers[index];
      if (blocker === undefined) {
        throw new Error(`no blocker for the ${lock.name}`);
      }
      await waitForPg(
        `placeOrder waiting at least ${mustWaitMs} ms on the ${lock.name}`,
        async () => {
          if (retried.length > 0) {
            throw new Error(
              `placeOrder's wait on the ${lock.name} ended in ${String(retried[0])} and was retried`,
            );
          }
          const waiting = await blockedBy(sessions, blocker.pid);
          return waiting.find((backend) => backend.waitedMs >= mustWaitMs);
        },
        { against: call },
      );
      observed.push(lock.name);
      await blocker.release();
    }
    const order = await call.catch((error: unknown) => {
      throw new Error("placeOrder failed after its three lock waits", { cause: error });
    });

    expect(observed).toEqual(["buyer advisory lock", "hold row", "seat rows"]);
    expect(order.status).toBe("PENDING_PAYMENT");
    expect(await db.order.count({ where: { holdId: hold.id } })).toBe(1);
    expect(retried).toEqual([]);
    expect(recorder.count("deadlock_retry")).toBe(0);
  } finally {
    for (const blocker of blockers) {
      await blocker.release().catch(() => undefined);
    }
  }
}, 30_000);
