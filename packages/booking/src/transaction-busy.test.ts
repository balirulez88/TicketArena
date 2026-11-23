import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  type PrismaClient,
  type PrismaClientOptions,
  seedCatalog,
  type TransactionClient,
} from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeAll, describe, expect, test } from "vitest";
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
  blockedBy,
  type Occupation,
  occupy,
  postgresErrorOf,
  testTrigger,
  waitFor,
} from "./testing";
import { classifyBookingError } from "./transaction-errors";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
const CONTACT = { email: "buyer@example.com" };
// The real-driver messages the classifier is coupled to (see transaction-errors.ts).
const POOL_ACQUIRE_TIMEOUT = "timeout exceeded when trying to connect";
const TRANSACTION_START_TIMEOUT = "Unable to start a transaction in the given time";
const STATEMENT_TIMEOUT_CANCEL = "canceling statement due to statement timeout";
const USER_REQUEST_CANCEL = "canceling statement due to user request";

beforeAll(async () => {
  await withClient({}, (db) => seedCatalog(db, NOW));
});

/** Every test builds and disconnects its own clients; none is shared across tests. */
async function withClient<T>(
  options: Partial<PrismaClientOptions>,
  work: (db: PrismaClient) => Promise<T>,
): Promise<T> {
  const db = createPrismaClient({ connectionString: database.url, driver: "pg", ...options });
  try {
    return await work(db);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Opens a one-connection pool's connection through `occupy`, which retries a slow first connect,
 * and leaves it idle in the pool: a short acquire timeout then only ever meets a full pool, never
 * a connection still opening on a loaded machine.
 */
async function warm(db: PrismaClient): Promise<void> {
  await (await occupy(db)).release();
}

function newBuyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

function harness(db: PrismaClient, deps: Partial<BookingServiceDeps> = {}) {
  const counted: { metric: BookingMetric; eventId: string }[] = [];
  const service = createBookingService({
    db,
    clock: { now: () => NOW },
    newId: randomUUID,
    metrics: {
      increment: (metric, eventId) => {
        counted.push({ metric, eventId });
        return Promise.resolve();
      },
    },
    delay: () => Promise.resolve(),
    ...deps,
  });
  const count = (metric: BookingMetric) => counted.filter((entry) => entry.metric === metric);
  return { service, counted, count };
}

async function freeSeats(db: PrismaClient, take: number) {
  const event = await db.event.findFirstOrThrow({ where: { demo: true } });
  const seats = await db.seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "desc" },
    take,
  });
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

describe("pool acquire timeout (pg)", () => {
  const tight = { poolMax: 1, acquireTimeoutMs: 300 } as const;

  test("holdSeats on a pool whose only connection is occupied is BOOKING_BUSY, counted", async () => {
    await withClient(tight, async (db) => {
      await warm(db);
      const { eventId, seatIds } = await freeSeats(db, 1);
      const { service, count } = harness(db);
      const occupation = await occupy(db);
      let error: unknown;
      try {
        error = await service.holdSeats(newBuyer(), eventId, seatIds).catch((e: unknown) => e);
      } finally {
        await occupation.release();
      }

      expect(error).toBeInstanceOf(BookingBusyError);
      expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
      expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
    });
  });

  test("placeOrder refused on its first pool read, before the event is known, counts under 'unknown'", async () => {
    await withClient(tight, async (db) => {
      await warm(db);
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const { service, count } = harness(db);
      const hold = await service.holdSeats(buyer, eventId, seatIds);
      const occupation = await occupy(db);
      let error: unknown;
      try {
        error = await service
          .placeOrder(buyer, hold.id, CONTACT, randomUUID())
          .catch((e: unknown) => e);
      } finally {
        await occupation.release();
      }

      expect(error).toBeInstanceOf(BookingBusyError);
      expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
      expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId: "unknown" }]);
    });
  });

  test("placeOrder's idempotency re-read after a duplicate key, on a saturated pool, is BOOKING_BUSY, counted", async () => {
    await withClient({ poolMax: 1, acquireTimeoutMs: 1_000 }, async (db) => {
      await warm(db);
      await withClient({}, async (other) => {
        const buyer = newBuyer();
        const key = randomUUID();
        const { eventId, seatIds } = await freeSeats(db, 1);
        const { service, count } = harness(db);
        const hold = await service.holdSeats(buyer, eventId, seatIds);
        const table = `uniq_${randomUUID().replaceAll("-", "")}`;
        await other.$executeRawUnsafe(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
        await other.$executeRawUnsafe(`INSERT INTO ${table} VALUES (1)`);
        const lockKey = Math.floor(Math.random() * 1_000_000_000);
        // The order insert waits for the test's latch, then hits a real duplicate key.
        const trigger = await testTrigger(other, {
          table: "orders",
          timing: "BEFORE INSERT",
          when: `NEW."idempotencyKey" = '${key}'`,
          body: `PERFORM pg_advisory_xact_lock(${lockKey}); INSERT INTO ${table} VALUES (1);`,
        });
        const blocker = await block(
          other,
          (tx: TransactionClient) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`,
        );
        let occupying: Promise<Occupation> | undefined;
        try {
          const call = service.placeOrder(buyer, hold.id, CONTACT, key);
          call.catch(() => undefined);
          // The transaction now holds the pool's only connection.
          await waitFor(
            "placeOrder's order insert waiting on the latch",
            async () => (await blockedBy(other, blocker.pid))[0],
            { against: call },
          );
          // Queued first, so the connection the rolled-back transaction frees goes to the
          // occupier and the re-read that follows finds the pool full. The round trip lets the
          // occupier's start reach the pool's queue before the latch opens.
          occupying = occupy(db);
          await other.$queryRaw`SELECT 1`;
          await blocker.release();
          const error = await call.catch((e: unknown) => e);

          expect(error).toBeInstanceOf(BookingBusyError);
          expect(causeOf(error)).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
          expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
          expect(await trigger.calls()).toBe(1);
        } finally {
          await blocker.release().catch(() => undefined);
          await (await occupying)?.release();
          await trigger.remove();
        }
      });
    });
  });
});

describe("transaction start timeout, isolated", () => {
  /**
   * The first attempt fails with a real 40001; while the retry waits on the timer seam the test
   * fills the pool, so the second attempt cannot start its transaction. The reads before the
   * transaction ran on a free pool.
   */
  async function busyOnRetryStart(options: Partial<PrismaClientOptions>): Promise<unknown> {
    return withClient({ poolMax: 1, ...options }, async (db) => {
      await warm(db);
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const trigger = await testTrigger(db, {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `IF $calls = 1 THEN
                 RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
               END IF;`,
      });
      let occupation: Occupation | undefined;
      try {
        const { service, count } = harness(db, {
          delay: async () => {
            occupation = await occupy(db);
          },
        });
        const error = await service.holdSeats(buyer, eventId, seatIds).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BookingBusyError);
        expect(count("deadlock_retry")).toHaveLength(1);
        expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
        return causeOf(error);
      } finally {
        await occupation?.release();
        await trigger.remove();
      }
    });
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
  });

  test("a short acquire timeout with a long maxWait: the cause is the pool acquire timeout", async () => {
    const cause = await busyOnRetryStart({
      acquireTimeoutMs: 300,
      transaction: { maxWaitMs: 60_000, timeoutMs: 5_000 },
    });

    expect(cause).toMatchObject({ message: POOL_ACQUIRE_TIMEOUT });
    expect(cause).not.toMatchObject({ code: "P2028" });
  });
});

describe("P2028 that is not saturation", () => {
  test("a transaction past its own runtime timeout is an internal error after exactly one attempt", async () => {
    await withClient({ transaction: { maxWaitMs: 2_000, timeoutMs: 300 } }, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const trigger = await testTrigger(db, {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: "PERFORM pg_sleep(0.6);",
      });
      try {
        const { service, count } = harness(db);

        const error = await service.holdSeats(buyer, eventId, seatIds).catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(error).toMatchObject({
          code: "P2028",
          message: expect.stringMatching(/expired transaction/),
        });
        expect(await trigger.calls()).toBe(1);
        expect(count("booking_busy")).toEqual([]);
        expect(count("deadlock_retry")).toEqual([]);
        expect(await db.hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(0);
      } finally {
        await trigger.remove();
      }
    });
  });

  test("'Transaction already closed' captured from Prisma is not saturation", async () => {
    await withClient({}, async (db) => {
      let leaked: TransactionClient | undefined;
      await db.$transaction(async (tx) => {
        leaked = tx;
      });
      if (leaked === undefined) {
        throw new Error("the transaction callback did not run");
      }
      const error = await leaked.$queryRaw`SELECT 1`.catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "P2028",
        message: expect.stringContaining("Transaction already closed"),
      });
      expect(classifyBookingError(error)).toBe("internal");
    });
  });
});

describe("SQLSTATE 57014", () => {
  /** Sleeps inside the service's own hold insert, so the statement can be cancelled. */
  function sleepingHolds(db: PrismaClient, buyer: Buyer, seconds: number) {
    return testTrigger(db, {
      table: "holds",
      timing: "BEFORE INSERT",
      when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
      body: `PERFORM pg_sleep(${seconds});`,
    });
  }

  test("cancelled by statement_timeout: BOOKING_BUSY after one attempt, counted", async () => {
    const timeouts: BookingTimeouts = { lockTimeoutMs: 3_000, statementTimeoutMs: 200, retries: 3 };
    await withClient({ transaction: bookingTransactionOptions(timeouts) }, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const trigger = await sleepingHolds(db, buyer, 5);
      try {
        const { service, count } = harness(db, { timeouts });

        const error = await service.holdSeats(buyer, eventId, seatIds).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(BookingBusyError);
        expect(postgresErrorOf(error)).toEqual({
          code: "57014",
          message: STATEMENT_TIMEOUT_CANCEL,
        });
        expect(await trigger.calls()).toBe(1);
        expect(count("booking_busy")).toEqual([{ metric: "booking_busy", eventId }]);
        expect(count("deadlock_retry")).toEqual([]);
      } finally {
        await trigger.remove();
      }
    });
  });

  test("cancelled by another session: not BOOKING_BUSY, rethrown with 57014 in its cause chain", async () => {
    const timeouts: BookingTimeouts = {
      lockTimeoutMs: 3_000,
      statementTimeoutMs: 20_000,
      retries: 3,
    };
    await withClient({ transaction: bookingTransactionOptions(timeouts) }, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const trigger = await sleepingHolds(db, buyer, 15);
      try {
        const { service, count } = harness(db, { timeouts });
        const call = service.holdSeats(buyer, eventId, seatIds);
        call.catch(() => undefined);
        const pid = await waitFor(
          "service backend sleeping in its hold insert",
          async () =>
            (
              await db.$queryRaw<{ pid: number }[]>`
                SELECT pid FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event = 'PgSleep'`
            )[0]?.pid,
          { against: call },
        );
        await db.$queryRaw`SELECT pg_cancel_backend(${pid}::int)`;

        const error = await call.catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(postgresErrorOf(error)).toEqual({ code: "57014", message: USER_REQUEST_CANCEL });
        expect(await trigger.calls()).toBe(1);
        expect(count("booking_busy")).toEqual([]);
        expect(count("deadlock_retry")).toEqual([]);
      } finally {
        await trigger.remove();
      }
    });
  }, 30_000);
});
