import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import {
  BookingBusyError,
  type BookingMetric,
  type BookingServiceDeps,
  createBookingService,
} from "./booking-service";
import {
  bookingTransactionOptions,
  DEFAULT_BOOKING_TIMEOUTS,
  RETRY_JITTER_MAX_MS,
  RETRY_JITTER_MIN_MS,
} from "./booking-transaction";
import {
  block,
  bookingTestBed,
  buyerLock,
  failureOf,
  freeSeats,
  freshBuyer,
  NOW,
  recordingMetrics,
  rowLock,
  sqlStateOf,
  waitUntilBlocked,
  withTrigger,
} from "./testing";

const database = setupTestDatabase();
const { db, open } = bookingTestBed(database);
const CONTACT = { email: "buyer@example.com" };
// Short enough that four attempts blocked past lock_timeout settle quickly.
const SHORT = { lockTimeoutMs: 100, statementTimeoutMs: 2_000, retries: 3 };

interface Harness {
  readonly service: ReturnType<typeof createBookingService>;
  readonly delays: number[];
  readonly count: (metric: BookingMetric) => number;
}

function harness(client: PrismaClient, deps: Partial<BookingServiceDeps> = {}): Harness {
  const metrics = recordingMetrics<BookingMetric>();
  const delays: number[] = [];
  const booking = createBookingService({
    db: client,
    clock: { now: () => NOW },
    newId: randomUUID,
    metrics: metrics.metrics,
    // The timer seam records the delay and resolves at once: no test waits on wall-clock jitter.
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    ...deps,
  });
  return { service: booking, delays, count: metrics.count };
}

/** Fails the hold's seat.held insert (its last write) with `body`, matched on the seat. */
function failingSeatHeld(seatId: string, body: string) {
  return {
    table: "outbox_events",
    timing: "BEFORE INSERT",
    when: `NEW."eventType" = 'seat.held' AND NEW.payload->'payload'->'seatIds' ? '${seatId}'`,
    body,
  };
}

describe("transaction settings", () => {
  test("holdSeats and placeOrder run with lock_timeout 3s and statement_timeout 5s, local to the transaction", async () => {
    const pool = open({
      poolMax: 1,
      transaction: bookingTransactionOptions(DEFAULT_BOOKING_TIMEOUTS),
    });
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(pool, 1, { order: "desc" });
    const [seatId] = seatIds;
    const [defaults] = await pool.$queryRaw<{ lock: string; statement: string }[]>`
      SELECT current_setting('lock_timeout') AS lock,
             current_setting('statement_timeout') AS statement`;
    await withTrigger(
      pool,
      {
        table: "seats",
        timing: "AFTER UPDATE",
        when: `NEW.id = '${seatId}'::uuid`,
        scratch: "status text, lock text, statement text",
        body: `INSERT INTO $scratch VALUES (NEW.status::text,
                 current_setting('lock_timeout'), current_setting('statement_timeout'));`,
      },
      async (trigger) => {
        const { service } = harness(pool);
        const hold = await service.holdSeats(buyer, eventId, seatIds);
        await service.placeOrder(buyer, hold.id, CONTACT, randomUUID());

        const recorded = await pool.$queryRawUnsafe<{ status: string }[]>(
          `SELECT status, lock, statement FROM ${trigger.scratch} ORDER BY status`,
        );
        expect(recorded).toEqual([
          { status: "HELD", lock: "3s", statement: "5s" },
          { status: "IN_CHECKOUT", lock: "3s", statement: "5s" },
        ]);
        // Pool size 1: the same connection, back at the server defaults after the commit.
        const [after] = await pool.$queryRaw<{ lock: string; statement: string }[]>`
          SELECT current_setting('lock_timeout') AS lock,
                 current_setting('statement_timeout') AS statement`;
        expect(after).toEqual(defaults);
      },
    );
  });
});

describe("retry set", () => {
  test("a unique violation inside the transaction is not retried: exactly one attempt", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    await withTrigger(
      db(),
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        scratch: "id int PRIMARY KEY",
        body: "INSERT INTO $scratch VALUES (1); INSERT INTO $scratch VALUES (1);",
      },
      async (trigger) => {
        const { service, delays, count } = harness(db(), { timeouts: SHORT });

        const error = await failureOf(service.holdSeats(buyer, eventId, seatIds));

        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(error).toMatchObject({ code: "P2002" });
        expect(await trigger.calls()).toBe(1);
        expect(delays).toEqual([]);
        expect(count("deadlock_retry")).toBe(0);
        expect(count("booking_busy")).toBe(0);
      },
    );
  });
});

describe("55P03: blocked past lock_timeout", () => {
  test("holdSeats makes 4 attempts, then BOOKING_BUSY with deadlock_retry 3 and booking_busy 1", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    const blocker = await block(db(), rowLock("seats", seatIds), { what: "the seat lock" });
    const { service, delays, count } = harness(db(), { timeouts: SHORT });
    let error: unknown;
    try {
      error = await failureOf(service.holdSeats(buyer, eventId, seatIds));
    } finally {
      // Released only after the call has settled.
      await blocker.release();
    }

    expect(error).toBeInstanceOf(BookingBusyError);
    expect(sqlStateOf(error)).toBe("55P03");
    expect(delays).toHaveLength(3);
    expect(count("deadlock_retry")).toBe(3);
    expect(count("booking_busy")).toBe(1);
    expect(await db().hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(0);
  });

  test("placeOrder makes 4 attempts, then BOOKING_BUSY with deadlock_retry 3 and booking_busy 1", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    const { service, delays, count } = harness(db(), { timeouts: SHORT });
    const hold = await service.holdSeats(buyer, eventId, seatIds);
    const blocker = await block(db(), rowLock("holds", [hold.id]), { what: "the hold lock" });
    let error: unknown;
    try {
      error = await failureOf(service.placeOrder(buyer, hold.id, CONTACT, randomUUID()));
    } finally {
      await blocker.release();
    }

    expect(error).toBeInstanceOf(BookingBusyError);
    expect(sqlStateOf(error)).toBe("55P03");
    expect(delays).toHaveLength(3);
    expect(count("deadlock_retry")).toBe(3);
    expect(count("booking_busy")).toBe(1);
    expect(await db().order.count({ where: { holdId: hold.id } })).toBe(0);
  });
});

describe("40P01: deadlock (AT-05)", () => {
  test("the service, made the deadlock victim, retries the whole transaction and holds once", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    const { service, count } = harness(db());
    // The outside session holds the seat the service will wait for. Once the service waits on
    // it (holding its buyer lock), the outside session asks for that buyer lock: a cycle.
    // The service began waiting first, so its deadlock check runs first and it is the victim.
    const outside = await block(db(), rowLock("seats", seatIds), {
      what: "the seat lock",
      afterRelease: buyerLock(eventId, buyer.buyerKey),
    });
    const call = service.holdSeats(buyer, eventId, seatIds);
    call.catch(() => undefined);
    let closed: Promise<void> | undefined;
    try {
      await waitUntilBlocked(db(), outside.pid, {
        what: "service backend blocked by the outside session",
        against: call,
      });
      // Immediately, well within deadlock_timeout (1 s).
      closed = outside.release();
      await closed.catch((error: unknown) => {
        throw new Error(
          "the outside session was aborted as the deadlock victim instead of the service",
          { cause: error },
        );
      });
      const hold = await call;

      expect(hold.status).toBe("HELD");
      expect(count("deadlock_retry")).toBe(1);
      expect(await db().hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(1);
    } finally {
      await (closed ?? outside.release()).catch(() => undefined);
    }
  }, 20_000);
});

describe("40001: serialization failure", () => {
  test("a real 40001 on the first attempt only is retried; the first attempt left no rows", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    await withTrigger(
      db(),
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `IF $calls = 1 THEN
                 RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
               END IF;`,
      },
      async (trigger) => {
        const ids: string[] = [];
        const { service, count } = harness(db(), {
          newId: () => {
            const id = randomUUID();
            ids.push(id);
            return id;
          },
        });

        const hold = await service.holdSeats(buyer, eventId, seatIds);

        expect(await trigger.calls()).toBe(2);
        expect(count("deadlock_retry")).toBe(1);
        const holds = await db().hold.findMany({ where: { buyerKey: buyer.buyerKey } });
        expect(holds.map((row) => row.id)).toEqual([hold.id]);
        // The first attempt minted ids too; none of them reached a table.
        const firstAttempt = ids.slice(0, ids.indexOf(hold.id));
        expect(firstAttempt.length).toBeGreaterThan(0);
        expect(await db().hold.count({ where: { id: { in: firstAttempt } } })).toBe(0);
        expect(await db().outboxEvent.count({ where: { aggregateId: { in: firstAttempt } } })).toBe(
          0,
        );
        expect(await db().outboxEvent.count({ where: { aggregateId: hold.id } })).toBe(1);
      },
    );
  });

  // TD-018 on a retried attempt: both attempts fail at their last write, after the hold insert
  // and the seat update. The first fails retryably, the second for good.
  test("a retried attempt that fails after its writes have begun leaves nothing of either attempt", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 2, { order: "desc" });
    const [seatId = ""] = seatIds;
    await withTrigger(
      db(),
      failingSeatHeld(
        seatId,
        `IF $calls = 1 THEN
           RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
         END IF;
         RAISE EXCEPTION 'test-induced failure of the retried attempt' USING ERRCODE = 'P0001';`,
      ),
      async (trigger) => {
        const ids: string[] = [];
        const { service, count } = harness(db(), {
          newId: () => {
            const id = randomUUID();
            ids.push(id);
            return id;
          },
        });

        const error = await failureOf(service.holdSeats(buyer, eventId, seatIds));

        expect(sqlStateOf(error)).toBe("P0001");
        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(await trigger.calls()).toBe(2);
        expect(count("deadlock_retry")).toBe(1);
        expect(ids.length).toBeGreaterThan(0);
        expect(await db().hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(0);
        expect(await db().hold.count({ where: { id: { in: ids } } })).toBe(0);
        expect(
          await db().outboxEvent.count({
            where: { OR: [{ id: { in: ids } }, { aggregateId: { in: ids } }] },
          }),
        ).toBe(0);
        expect(
          await db().seat.findMany({
            where: { id: { in: seatIds } },
            select: { status: true, holdId: true, claimBuyerKey: true },
          }),
        ).toEqual(seatIds.map(() => ({ status: "AVAILABLE", holdId: null, claimBuyerKey: null })));
      },
    );
  });
});

describe("jitter", () => {
  /** Fails the first `failures` attempts of the buyer's hold with a real 40001. */
  async function retriedHold(deps: Partial<BookingServiceDeps>, failures = 3): Promise<number[]> {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db(), 1, { order: "desc" });
    return withTrigger(
      db(),
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `IF $calls <= ${failures} THEN
                 RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
               END IF;`,
      },
      async () => {
        const { service, delays } = harness(db(), deps);
        await service.holdSeats(buyer, eventId, seatIds);
        return delays;
      },
    );
  }

  test("with a fixed random source the delays are exact", async () => {
    const draws = [0, 0.5, 0.999];
    const delays = await retriedHold({ random: () => draws.shift() ?? 0 });

    expect(delays).toEqual([20, 110, 199]);
  });

  test("two different random values give different delays", async () => {
    const low = await retriedHold({ random: () => 0.1 }, 1);
    const high = await retriedHold({ random: () => 0.9 }, 1);

    expect(low).toHaveLength(1);
    expect(high).toHaveLength(1);
    expect(low).not.toEqual(high);
  });

  test("with the default random source every delay lies inside the documented bounds", async () => {
    const delays = await retriedHold({});

    expect(delays).toHaveLength(3);
    for (const ms of delays) {
      expect(ms).toBeGreaterThanOrEqual(RETRY_JITTER_MIN_MS);
      expect(ms).toBeLessThan(RETRY_JITTER_MAX_MS);
    }
    expect([RETRY_JITTER_MIN_MS, RETRY_JITTER_MAX_MS]).toEqual([20, 200]);
  });
});
