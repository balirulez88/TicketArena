import { randomUUID } from "node:crypto";
import {
  createPrismaClient,
  type PrismaClient,
  type PrismaClientOptions,
  seedCatalog,
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
import {
  type BookingTimeouts,
  bookingTransactionOptions,
  DEFAULT_BOOKING_TIMEOUTS,
  RETRY_JITTER_MAX_MS,
  RETRY_JITTER_MIN_MS,
} from "./booking-transaction";
import { block, blockedBy, sqlStateOf, testTrigger, waitFor } from "./testing";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
const CONTACT = { email: "buyer@example.com" };
// Short enough that four attempts blocked past lock_timeout settle quickly.
const SHORT: BookingTimeouts = { lockTimeoutMs: 100, statementTimeoutMs: 2_000, retries: 3 };

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

function newBuyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

function recorder() {
  const counted: { metric: BookingMetric; eventId: string }[] = [];
  return {
    counted,
    metrics: {
      increment: (metric: BookingMetric, eventId: string) => {
        counted.push({ metric, eventId });
        return Promise.resolve();
      },
    },
    count: (metric: BookingMetric) => counted.filter((entry) => entry.metric === metric).length,
  };
}

interface Harness {
  readonly service: ReturnType<typeof createBookingService>;
  readonly delays: number[];
  readonly count: (metric: BookingMetric) => number;
}

function harness(db: PrismaClient, deps: Partial<BookingServiceDeps> = {}): Harness {
  const metrics = recorder();
  const delays: number[] = [];
  const service = createBookingService({
    db,
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
  return { service, delays, count: metrics.count };
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

/** The buyer advisory lock key, computed as the booking transaction computes it (ADR 0005). */
function lockBuyerSql(eventId: string, buyer: Buyer) {
  return (tx: Pick<PrismaClient, "$executeRaw">) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${buyer.buyerKey}`}, 0))`;
}

describe("transaction settings", () => {
  test("holdSeats and placeOrder run with lock_timeout 3s and statement_timeout 5s, local to the transaction", async () => {
    await withClient(
      { poolMax: 1, transaction: bookingTransactionOptions(DEFAULT_BOOKING_TIMEOUTS) },
      async (db) => {
        const buyer = newBuyer();
        const { eventId, seatIds } = await freeSeats(db, 1);
        const [seatId] = seatIds;
        const [defaults] = await db.$queryRaw<{ lock: string; statement: string }[]>`
          SELECT current_setting('lock_timeout') AS lock,
                 current_setting('statement_timeout') AS statement`;
        const table = `settings_${randomUUID().replaceAll("-", "")}`;
        await db.$executeRawUnsafe(
          `CREATE TABLE ${table} (status text, lock text, statement text)`,
        );
        const trigger = await testTrigger(db, {
          table: "seats",
          timing: "AFTER UPDATE",
          when: `NEW.id = '${seatId}'::uuid`,
          body: `INSERT INTO ${table} VALUES (NEW.status::text,
                   current_setting('lock_timeout'), current_setting('statement_timeout'));`,
        });
        try {
          const { service } = harness(db);
          const hold = await service.holdSeats(buyer, eventId, seatIds);
          await service.placeOrder(buyer, hold.id, CONTACT, randomUUID());

          const recorded = await db.$queryRawUnsafe<{ status: string }[]>(
            `SELECT status, lock, statement FROM ${table} ORDER BY status`,
          );
          expect(recorded).toEqual([
            { status: "HELD", lock: "3s", statement: "5s" },
            { status: "IN_CHECKOUT", lock: "3s", statement: "5s" },
          ]);
          // Pool size 1: the same connection, back at the server defaults after the commit.
          const [after] = await db.$queryRaw<{ lock: string; statement: string }[]>`
            SELECT current_setting('lock_timeout') AS lock,
                   current_setting('statement_timeout') AS statement`;
          expect(after).toEqual(defaults);
        } finally {
          await trigger.remove();
        }
      },
    );
  });
});

describe("retry set", () => {
  test("a unique violation inside the transaction is not retried: exactly one attempt", async () => {
    await withClient({}, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const table = `uniq_${randomUUID().replaceAll("-", "")}`;
      await db.$executeRawUnsafe(`CREATE TABLE ${table} (id int PRIMARY KEY)`);
      await db.$executeRawUnsafe(`INSERT INTO ${table} VALUES (1)`);
      const trigger = await testTrigger(db, {
        table: "holds",
        timing: "BEFORE INSERT",
        when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
        body: `INSERT INTO ${table} VALUES (1);`,
      });
      try {
        const { service, delays, count } = harness(db, { timeouts: SHORT });

        const error = await service.holdSeats(buyer, eventId, seatIds).catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(BookingBusyError);
        expect(error).toMatchObject({ code: "P2002" });
        expect(await trigger.calls()).toBe(1);
        expect(delays).toEqual([]);
        expect(count("deadlock_retry")).toBe(0);
        expect(count("booking_busy")).toBe(0);
      } finally {
        await trigger.remove();
      }
    });
  });
});

describe("55P03: blocked past lock_timeout", () => {
  test("holdSeats makes 4 attempts, then BOOKING_BUSY with deadlock_retry 3 and booking_busy 1", async () => {
    await withClient({}, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const blocker = await block(
        db,
        (tx) => tx.$queryRaw`SELECT id FROM seats WHERE id = ANY(${seatIds}::uuid[]) FOR UPDATE`,
      );
      const { service, delays, count } = harness(db, { timeouts: SHORT });
      let error: unknown;
      try {
        error = await service.holdSeats(buyer, eventId, seatIds).catch((e: unknown) => e);
      } finally {
        // Released only after the call has settled.
        await blocker.release();
      }

      expect(error).toBeInstanceOf(BookingBusyError);
      expect(sqlStateOf(error)).toBe("55P03");
      expect(delays).toHaveLength(3);
      expect(count("deadlock_retry")).toBe(3);
      expect(count("booking_busy")).toBe(1);
      expect(await db.hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(0);
    });
  });

  test("placeOrder makes 4 attempts, then BOOKING_BUSY with deadlock_retry 3 and booking_busy 1", async () => {
    await withClient({}, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const { service, delays, count } = harness(db, { timeouts: SHORT });
      const hold = await service.holdSeats(buyer, eventId, seatIds);
      const blocker = await block(
        db,
        (tx) => tx.$queryRaw`SELECT id FROM holds WHERE id = ${hold.id}::uuid FOR UPDATE`,
      );
      let error: unknown;
      try {
        error = await service
          .placeOrder(buyer, hold.id, CONTACT, randomUUID())
          .catch((e: unknown) => e);
      } finally {
        await blocker.release();
      }

      expect(error).toBeInstanceOf(BookingBusyError);
      expect(sqlStateOf(error)).toBe("55P03");
      expect(delays).toHaveLength(3);
      expect(count("deadlock_retry")).toBe(3);
      expect(count("booking_busy")).toBe(1);
      expect(await db.order.count({ where: { holdId: hold.id } })).toBe(0);
    });
  });
});

describe("40P01: deadlock (AT-05)", () => {
  test("the service, made the deadlock victim, retries the whole transaction and holds once", async () => {
    await withClient({}, async (db) => {
      const buyer = newBuyer();
      const { eventId, seatIds } = await freeSeats(db, 1);
      const { service, count } = harness(db);
      // The outside session holds the seat the service will wait for. Once the service waits on
      // it (holding its buyer lock), the outside session asks for that buyer lock: a cycle.
      // The service began waiting first, so its deadlock check runs first and it is the victim.
      const outside = await block(
        db,
        (tx) => tx.$queryRaw`SELECT id FROM seats WHERE id = ANY(${seatIds}::uuid[]) FOR UPDATE`,
        lockBuyerSql(eventId, buyer),
      );
      const call = service.holdSeats(buyer, eventId, seatIds);
      call.catch(() => undefined);
      let closed: Promise<void> | undefined;
      try {
        await waitFor(
          "service backend blocked by the outside session",
          async () => (await blockedBy(db, outside.pid))[0],
          { against: call },
        );
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
        expect(await db.hold.count({ where: { buyerKey: buyer.buyerKey } })).toBe(1);
      } finally {
        await (closed ?? outside.release()).catch(() => undefined);
      }
    });
  }, 20_000);
});

describe("40001: serialization failure", () => {
  test("a real 40001 on the first attempt only is retried; the first attempt left no rows", async () => {
    await withClient({}, async (db) => {
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
      try {
        const ids: string[] = [];
        const { service, count } = harness(db, {
          newId: () => {
            const id = randomUUID();
            ids.push(id);
            return id;
          },
        });

        const hold = await service.holdSeats(buyer, eventId, seatIds);

        expect(await trigger.calls()).toBe(2);
        expect(count("deadlock_retry")).toBe(1);
        const holds = await db.hold.findMany({ where: { buyerKey: buyer.buyerKey } });
        expect(holds.map((row) => row.id)).toEqual([hold.id]);
        // The first attempt minted ids too; none of them reached a table.
        const firstAttempt = ids.slice(0, ids.indexOf(hold.id));
        expect(firstAttempt.length).toBeGreaterThan(0);
        expect(await db.hold.count({ where: { id: { in: firstAttempt } } })).toBe(0);
        expect(await db.outboxEvent.count({ where: { aggregateId: { in: firstAttempt } } })).toBe(
          0,
        );
        expect(await db.outboxEvent.count({ where: { aggregateId: hold.id } })).toBe(1);
      } finally {
        await trigger.remove();
      }
    });
  });
});

describe("jitter", () => {
  /** Fails the first `failures` attempts of the buyer's hold with a real 40001. */
  async function retriedHold(
    db: PrismaClient,
    deps: Partial<BookingServiceDeps>,
    failures = 3,
  ): Promise<number[]> {
    const buyer = newBuyer();
    const { eventId, seatIds } = await freeSeats(db, 1);
    const trigger = await testTrigger(db, {
      table: "holds",
      timing: "BEFORE INSERT",
      when: `NEW."buyerKey" = '${buyer.buyerKey}'`,
      body: `IF $calls <= ${failures} THEN
               RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
             END IF;`,
    });
    try {
      const { service, delays } = harness(db, deps);
      await service.holdSeats(buyer, eventId, seatIds);
      return delays;
    } finally {
      await trigger.remove();
    }
  }

  test("with a fixed random source the delays are exact", async () => {
    await withClient({}, async (db) => {
      const draws = [0, 0.5, 0.999];
      const delays = await retriedHold(db, { random: () => draws.shift() ?? 0 });

      expect(delays).toEqual([20, 110, 199]);
    });
  });

  test("two different random values give different delays", async () => {
    await withClient({}, async (db) => {
      const low = await retriedHold(db, { random: () => 0.1 }, 1);
      const high = await retriedHold(db, { random: () => 0.9 }, 1);

      expect(low).toHaveLength(1);
      expect(high).toHaveLength(1);
      expect(low).not.toEqual(high);
    });
  });

  test("with the default random source every delay lies inside the documented bounds", async () => {
    await withClient({}, async (db) => {
      const delays = await retriedHold(db, {});

      expect(delays).toHaveLength(3);
      for (const ms of delays) {
        expect(ms).toBeGreaterThanOrEqual(RETRY_JITTER_MIN_MS);
        expect(ms).toBeLessThan(RETRY_JITTER_MAX_MS);
      }
      expect([RETRY_JITTER_MIN_MS, RETRY_JITTER_MAX_MS]).toEqual([20, 200]);
    });
  });
});
