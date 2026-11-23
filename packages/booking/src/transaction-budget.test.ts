import { randomUUID } from "node:crypto";
import type { Logger } from "@ticketarena/contracts";
import {
  createPrismaClient,
  type PrismaClient,
  type PrismaClientOptions,
  seedCatalog,
  type TransactionClient,
} from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { beforeAll, expect, test } from "vitest";
import { type BookingMetric, type Buyer, createBookingService } from "./booking-service";
import { type BookingTimeouts, bookingTransactionOptions } from "./booking-transaction";
import { type Blocker, block, blockedBy, waitFor } from "./testing";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");

beforeAll(async () => {
  await withClient({}, (db) => seedCatalog(db, NOW));
});

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

test("one placeOrder attempt waits on each of its three locks in turn and commits within the budget", async () => {
  // Shortened, but lock_timeout stays at least 1 s so 60% of it is a real wait.
  const timeouts: BookingTimeouts = { lockTimeoutMs: 1_500, statementTimeoutMs: 3_000, retries: 3 };
  const mustWaitMs = 0.6 * timeouts.lockTimeoutMs;

  await withClient({ transaction: bookingTransactionOptions(timeouts) }, async (db) => {
    await withClient({}, async (sessions) => {
      const key = randomUUID().replaceAll("-", "");
      const buyer: Buyer = { sessionId: key, buyerKey: key };
      const event = await db.event.findFirstOrThrow({ where: { demo: true } });
      const seats = await db.seat.findMany({
        where: { eventId: event.id, status: "AVAILABLE" },
        orderBy: { id: "asc" },
        take: 2,
      });
      const seatIds = seats.map((seat) => seat.id);
      const counted: BookingMetric[] = [];
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
      const service = createBookingService({
        db,
        clock: { now: () => NOW },
        newId: randomUUID,
        logger,
        timeouts,
        delay: () => Promise.resolve(),
        metrics: {
          increment: (metric) => {
            counted.push(metric);
            return Promise.resolve();
          },
        },
      });
      const hold = await service.holdSeats(buyer, event.id, seatIds);

      // placeOrder's lock order (ADR 0005): buyer advisory lock, hold row, seat rows.
      const locks: { readonly name: string; take(tx: TransactionClient): Promise<unknown> }[] = [
        {
          name: "buyer advisory lock",
          take: (tx) =>
            tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${event.id}:${key}`}, 0))`,
        },
        {
          name: "hold row",
          take: (tx) => tx.$queryRaw`SELECT id FROM holds WHERE id = ${hold.id}::uuid FOR UPDATE`,
        },
        {
          name: "seat rows",
          take: (tx) =>
            tx.$queryRaw`SELECT id FROM seats WHERE id = ANY(${seatIds}::uuid[]) FOR UPDATE`,
        },
      ];
      const blockers: Blocker[] = [];
      for (const lock of locks) {
        blockers.push(await block(sessions, lock.take));
      }
      const observed: string[] = [];
      try {
        const call = service.placeOrder(buyer, hold.id, { email: "b@example.com" }, randomUUID());
        call.catch(() => undefined);
        for (const [index, lock] of locks.entries()) {
          const blocker = blockers[index];
          if (blocker === undefined) {
            throw new Error(`no blocker for the ${lock.name}`);
          }
          await waitFor(
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
        expect(counted.filter((metric) => metric === "deadlock_retry")).toEqual([]);
      } finally {
        for (const blocker of blockers) {
          await blocker.release().catch(() => undefined);
        }
      }
    });
  });
}, 30_000);
