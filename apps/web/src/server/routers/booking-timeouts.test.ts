import { randomUUID } from "node:crypto";
import { createBookingService, DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import { occupy, postgresErrorOf, testTrigger, waitFor } from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import {
  createPrismaClient,
  type PrismaClient,
  type PrismaClientOptions,
  seedCatalog,
} from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { TRPCError } from "@trpc/server";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { Principal } from "../identity/identity";
import {
  bookingServiceFor,
  composeBooking,
  connectBooking,
  createTRPCContextFactory,
  type TRPCContext,
} from "../trpc";
import { createCaller } from "./_app";

const database = setupTestDatabase();
const NOW = new Date("2027-03-01T12:00:00.000Z");
const CONTACT = { email: "buyer@example.com" };

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

function contextFor(db: PrismaClient, principal: Principal): TRPCContext {
  const unused = (what: string) => () => {
    throw new Error(`${what} is not used by placeOrder`);
  };
  return {
    now: () => NOW,
    principal,
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger: silentLogger,
    metrics: unused("metrics"),
    metricsReader: unused("metricsReader"),
    metricsReset: unused("metricsReset"),
    rateLimiter: unused("rateLimiter"),
    // Reached only after an order committed; these orders never do.
    queueStore: () => Promise.reject(new Error("queueStore is not used by a failed placeOrder")),
    random: { next: () => 0 },
    admissionTokens: {
      issue: () => Promise.reject(new Error("no admission is issued here")),
      read: () => Promise.resolve(undefined),
    },
  };
}

/** A guest with a live hold on one free demo seat, made through the booking service itself. */
async function guestWithHold(db: PrismaClient) {
  const sessionId = randomUUID().replaceAll("-", "");
  const principal: Principal = { kind: "guest", sessionId };
  const event = await db.event.findFirstOrThrow({ where: { demo: true } });
  const seat = await db.seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
  });
  const hold = await createBookingService({
    db,
    clock: { now: () => NOW },
    newId: randomUUID,
  }).holdSeats({ sessionId, buyerKey: sessionId }, event.id, [seat.id]);
  return { principal, hold };
}

describe("booking.placeOrder errors", () => {
  test("a saturated database is TOO_MANY_REQUESTS with BOOKING_BUSY", async () => {
    const { principal, hold } = await withClient({}, guestWithHold);
    await withClient({ poolMax: 1, acquireTimeoutMs: 300 }, async (db) => {
      // occupy opens the pool's only connection itself, retrying a slow first connect, so the
      // short acquire timeout below only ever meets a full pool.
      const occupation = await occupy(db);
      let error: unknown;
      try {
        error = await createCaller(contextFor(db, principal))
          .booking.placeOrder({ holdId: hold.id, contact: CONTACT, idempotencyKey: randomUUID() })
          .catch((e: unknown) => e);
      } finally {
        await occupation.release();
      }

      expect(error).toBeInstanceOf(TRPCError);
      expect(error).toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: expect.stringMatching(/^BOOKING_BUSY/),
        cause: { code: "BOOKING_BUSY" },
      });
    });
  });

  test("a statement cancelled by another session is INTERNAL_SERVER_ERROR with 57014 in its cause", async () => {
    await withClient({}, async (db) => {
      const { principal, hold } = await guestWithHold(db);
      const idempotencyKey = randomUUID();
      const trigger = await testTrigger(db, {
        table: "orders",
        timing: "BEFORE INSERT",
        when: `NEW."idempotencyKey" = '${idempotencyKey}'`,
        body: "PERFORM pg_sleep(4);",
      });
      try {
        const call = createCaller(contextFor(db, principal)).booking.placeOrder({
          holdId: hold.id,
          contact: CONTACT,
          idempotencyKey,
        });
        call.catch(() => undefined);
        const pid = await waitFor(
          "placeOrder's backend sleeping in its order insert",
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

        expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
        expect(postgresErrorOf(error)).toEqual({
          code: "57014",
          message: "canceling statement due to user request",
        });
      } finally {
        await trigger.remove();
      }
    });
  }, 20_000);
});

describe("booking service timeouts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("a request context composed with non-default timeouts runs its booking transactions with them", async () => {
    vi.stubEnv("SESSION_SECRET", "s".repeat(32));
    const timeouts = { lockTimeoutMs: 1_234, statementTimeoutMs: 4_321, retries: 1 };
    const runtime = connectBooking(
      composeBooking({ DATABASE_URL: database.url, DATABASE_DRIVER: "pg" }, timeouts),
    );
    try {
      const ctx = await createTRPCContextFactory(() => runtime)({
        req: new Request("https://ticketarena.example/api/trpc"),
        resHeaders: new Headers(),
      });
      const sessionId = randomUUID().replaceAll("-", "");
      const event = await runtime.db.event.findFirstOrThrow({ where: { demo: true } });
      const seat = await runtime.db.seat.findFirstOrThrow({
        where: { eventId: event.id, status: "AVAILABLE" },
      });
      const table = `settings_${randomUUID().replaceAll("-", "")}`;
      await runtime.db.$executeRawUnsafe(`CREATE TABLE ${table} (lock text, statement text)`);
      const trigger = await testTrigger(runtime.db, {
        table: "seats",
        timing: "AFTER UPDATE",
        when: `NEW.id = '${seat.id}'::uuid`,
        body: `INSERT INTO ${table} VALUES (current_setting('lock_timeout'), current_setting('statement_timeout'));`,
      });
      try {
        await bookingServiceFor({ ...ctx, now: () => NOW }).holdSeats(
          { sessionId, buyerKey: sessionId },
          event.id,
          [seat.id],
        );

        const recorded = await runtime.db.$queryRawUnsafe<unknown[]>(
          `SELECT lock, statement FROM ${table}`,
        );
        expect(recorded).toEqual([{ lock: "1234ms", statement: "4321ms" }]);
      } finally {
        await trigger.remove();
      }
    } finally {
      await runtime.db.$disconnect();
    }
  });
});
