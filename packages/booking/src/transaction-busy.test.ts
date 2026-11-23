import { randomUUID } from "node:crypto";
import type { PoolCounters, PrismaClient, TransactionClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import {
  BookingBusyError,
  type BookingMetric,
  type BookingServiceDeps,
  type Buyer,
  createBookingService,
} from "./booking-service";
import { type BookingTimeouts, bookingTransactionOptions } from "./booking-transaction";
import {
  block,
  bookingTestBed,
  type ClientOptions,
  failureOf,
  freeSeats,
  freshBuyer,
  NOW,
  type Occupation,
  occupy,
  postgresErrorOf,
  recordingMetrics,
  waitUntilBlocked,
  withTrigger,
} from "./testing";
import { classifyBookingError } from "./transaction-errors";

const database = setupTestDatabase();
const { open } = bookingTestBed(database);
const CONTACT = { email: "buyer@example.com" };
// The real-driver messages the classifier is coupled to (see transaction-errors.ts).
const POOL_ACQUIRE_TIMEOUT = "timeout exceeded when trying to connect";
const TRANSACTION_START_TIMEOUT = "Unable to start a transaction in the given time";
const STATEMENT_TIMEOUT_CANCEL = "canceling statement due to statement timeout";
const USER_REQUEST_CANCEL = "canceling statement due to user request";

/**
 * Opens a one-connection pool's connection through `occupy`, which retries a slow first connect,
 * and leaves it idle in the pool: a short acquire timeout then only ever meets a full pool, never
 * a connection still opening on a loaded machine.
 */
async function warm(db: PrismaClient): Promise<void> {
  await (await occupy(db)).release();
}

function harness(db: PrismaClient, deps: Partial<BookingServiceDeps> = {}) {
  const recorder = recordingMetrics<BookingMetric>();
  const booking = createBookingService({
    db,
    clock: { now: () => NOW },
    newId: randomUUID,
    metrics: recorder.metrics,
    delay: () => Promise.resolve(),
    ...deps,
  });
  return { service: booking, counted: recorder.counted, count: recorder.of };
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

describe("pool acquire timeout (pg)", () => {
  const tight: ClientOptions = { poolMax: 1, acquireTimeoutMs: 300 };

  test("holdSeats on a pool whose only connection is occupied is BOOKING_BUSY, counted", async () => {
    const db = open(tight);
    await warm(db);
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    const { service, count } = harness(db);
    const occupation = await occupy(db);
    let error: unknown;
    try {
      error = await failureOf(service.holdSeats(freshBuyer(), eventId, seatIds));
    } finally {
      await occupation.release();
    }

    expect(error).toBeInstanceOf(BookingBusyError);
    expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
    expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
  }, 20_000);

  test("placeOrder refused on its first pool read, before the event is known, counts under 'unknown'", async () => {
    const db = open(tight);
    await warm(db);
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    const { service, count } = harness(db);
    const hold = await service.holdSeats(buyer, eventId, seatIds);
    const occupation = await occupy(db);
    let error: unknown;
    try {
      error = await failureOf(service.placeOrder(buyer, hold.id, CONTACT, randomUUID()));
    } finally {
      await occupation.release();
    }

    expect(error).toBeInstanceOf(BookingBusyError);
    expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
    expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId: "unknown" }]);
  }, 20_000);

  test("placeOrder's idempotency re-read after a duplicate key, on a saturated pool, is BOOKING_BUSY, counted", async () => {
    let pool: PoolCounters | undefined;
    const db = open({
      poolMax: 1,
      acquireTimeoutMs: 1_000,
      observePool: (counters) => {
        pool = counters;
      },
    });
    await warm(db);
    const other = open();
    const buyer = freshBuyer();
    const key = randomUUID();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    const { service, count } = harness(db);
    const hold = await service.holdSeats(buyer, eventId, seatIds);
    const lockKey = Math.floor(Math.random() * 1_000_000_000);
    // The order insert waits for the test's latch, then hits a real duplicate key.
    await withTrigger(
      other,
      {
        table: "orders",
        timing: "BEFORE INSERT",
        when: `NEW."idempotencyKey" = '${key}'`,
        scratch: "id int PRIMARY KEY",
        body: `PERFORM pg_advisory_xact_lock(${lockKey});
               INSERT INTO $scratch VALUES (1); INSERT INTO $scratch VALUES (1);`,
      },
      async (trigger) => {
        const blocker = await block(
          other,
          (tx: TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`,
          { what: "the test's latch lock" },
        );
        let occupying: Promise<Occupation> | undefined;
        try {
          const call = service.placeOrder(buyer, hold.id, CONTACT, key);
          call.catch(() => undefined);
          // The transaction now holds the pool's only connection.
          await waitUntilBlocked(other, blocker.pid, {
            what: "placeOrder's order insert waiting on the latch",
            against: call,
          });
          // Queued first, so the connection the rolled-back transaction frees goes to the
          // occupier and the re-read that follows finds the pool full. The pool's own counter
          // proves the occupier is in its queue before the latch opens.
          occupying = occupy(db);
          await expect.poll(() => pool?.waitingCount).toBe(1);
          await blocker.release();
          const error = await failureOf(call);

          expect(error).toBeInstanceOf(BookingBusyError);
          expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
          expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
          expect(await trigger.calls()).toBe(1);
        } finally {
          await blocker.release().catch(() => undefined);
          await (await occupying)?.release();
        }
      },
    );
  }, 20_000);
});

describe("transaction start timeout, isolated", () => {
  /**
   * The first attempt fails with a real 40001; while the retry waits on the timer seam the test
   * fills the pool, so the second attempt cannot start its transaction. The reads before the
   * transaction ran on a free pool.
   */
  async function busyOnRetryStart(options: ClientOptions): Promise<unknown> {
    const db = open({ poolMax: 1, ...options });
    await warm(db);
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    return withTrigger(
      db,
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `IF $calls = 1 THEN
                 RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
               END IF;`,
      },
      async () => {
        let occupation: Occupation | undefined;
        try {
          const { service, count } = harness(db, {
            delay: async () => {
              occupation = await occupy(db);
            },
          });
          const error = await failureOf(service.holdSeats(buyer, eventId, seatIds));

          expect(error).toBeInstanceOf(BookingBusyError);
          expect(count("deadlock_retry")).toHaveLength(1);
          expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
          return causeOf(error);
        } finally {
          await occupation?.release();
        }
      },
    );
  }

  test("a short maxWait with a long acquire timeout: the cause is the start-timeout P2028", async () => {
    const cause = await busyOnRetryStart({
      acquireTimeoutMs: 60_000,
      transaction: { maxWaitMs: 300, timeoutMs: 5_000 },
    });

    expect(cause).toMatchObject({
      code: "P2028",
      message: expect.stringContaining(TRANSACTION_START_TIMEOUT),
    });
  }, 20_000);

  test("a short acquire timeout with a long maxWait: the cause is the pool acquire timeout", async () => {
    const cause = await busyOnRetryStart({
      acquireTimeoutMs: 300,
      transaction: { maxWaitMs: 60_000, timeoutMs: 5_000 },
    });

    expect(cause).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
    expect(cause).not.toMatchObject({ code: "P2028" });
  }, 20_000);
});

describe("P2028 that is not saturation", () => {
  test("a transaction past its own runtime timeout is an internal error after exactly one attempt", async () => {
    const db = open({ transaction: { maxWaitMs: 2_000, timeoutMs: 300 } });
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    // The one kind of sleep allowed: inside the service's own transaction, past its injected
    // transaction timeout.
    await withTrigger(
      db,
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: "PERFORM pg_sleep(0.6);",
      },
      async (trigger) => {
        const { service, count } = harness(db);

        const error = await failureOf(service.holdSeats(buyer, eventId, seatIds));

        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(error).toMatchObject({
          code: "P2028",
          message: expect.stringMatching(/expired transaction/),
        });
        expect(await trigger.calls()).toBe(1);
        expect(count("booking_busy")).toEqual([]);
        expect(count("deadlock_retry")).toEqual([]);
        expect(await db.hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(0);
      },
    );
  }, 20_000);

  test("'Transaction already closed' captured from Prisma is not saturation", async () => {
    const db = open();
    let leaked: TransactionClient | undefined;
    await db.$transaction(async (tx) => {
      leaked = tx;
    });
    if (leaked === undefined) {
      throw new Error("the transaction callback did not run");
    }
    const error = await failureOf(leaked.$queryRaw`SELECT 1`);

    expect(error).toMatchObject({
      code: "P2028",
      message: expect.stringContaining("Transaction already closed"),
    });
    expect(classifyBookingError(error)).toBe("internal");
  });
});

describe("SQLSTATE 57014", () => {
  test("cancelled by statement_timeout: BOOKING_BUSY after one attempt, counted", async () => {
    const timeouts: BookingTimeouts = { lockTimeoutMs: 3_000, statementTimeoutMs: 200, retries: 3 };
    const db = open({ transaction: bookingTransactionOptions(timeouts) });
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    // The one kind of sleep allowed: inside the service's own transaction, past its injected
    // statement_timeout.
    await withTrigger(
      db,
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: "PERFORM pg_sleep(5);",
      },
      async (trigger) => {
        const { service, count } = harness(db, { timeouts });

        const error = await failureOf(service.holdSeats(buyer, eventId, seatIds));

        expect(error).toBeInstanceOf(BookingBusyError);
        expect(postgresErrorOf(error)).toEqual({
          code: "57014",
          message: STATEMENT_TIMEOUT_CANCEL,
        });
        expect(await trigger.calls()).toBe(1);
        expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
        expect(count("deadlock_retry")).toEqual([]);
      },
    );
  }, 20_000);

  test("cancelled by another session: not BOOKING_BUSY, rethrown with 57014 in its cause chain", async () => {
    // Budgets far beyond the test: only the cancel can end the service's statement.
    const timeouts: BookingTimeouts = {
      lockTimeoutMs: 20_000,
      statementTimeoutMs: 20_000,
      retries: 3,
    };
    const db = open({ transaction: bookingTransactionOptions(timeouts) });
    const buyer: Buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1, { order: "desc" });
    const lockKey = Math.floor(Math.random() * 1_000_000_000);
    // The service's hold insert waits on a lock the test holds, until the test cancels it.
    await withTrigger(
      db,
      {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `PERFORM pg_advisory_xact_lock(${lockKey});`,
      },
      async (trigger) => {
        const blocker = await block(
          db,
          (tx: TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`,
          { what: "the test's latch lock" },
        );
        try {
          const { service, count } = harness(db, { timeouts });
          const call = service.holdSeats(buyer, eventId, seatIds);
          call.catch(() => undefined);
          const [waiting] = await waitUntilBlocked(db, blocker.pid, {
            what: "the service's hold insert waiting on the test's lock",
            against: call,
          });
          if (waiting === undefined) {
            throw new Error("no backend waits on the test's lock");
          }
          await db.$queryRaw`SELECT pg_cancel_backend(${waiting.pid}::int)`;

          const error = await failureOf(call);

          expect(error).not.toBeInstanceOf(BookingBusyError);
          expect(postgresErrorOf(error)).toEqual({ code: "57014", message: USER_REQUEST_CANCEL });
          expect(await trigger.calls()).toBe(1);
          expect(count("booking_busy")).toEqual([]);
          expect(count("deadlock_retry")).toEqual([]);
        } finally {
          await blocker.release();
        }
      },
    );
  }, 30_000);
});
