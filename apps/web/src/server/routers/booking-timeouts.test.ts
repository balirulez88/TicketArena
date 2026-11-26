import { randomUUID } from "node:crypto";
import { createBookingService, DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import {
  block,
  failureOf,
  freeSeats,
  NOW,
  occupy,
  postgresErrorOf,
  testClients,
  waitUntilBlocked,
  withClient,
  withTrigger,
} from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
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
const { db, open } = testClients(database);
const CONTACT = { email: "buyer@example.com" };

beforeAll(async () => {
  await withClient(database, (seeding) => seedCatalog(seeding, NOW));
});

function contextFor(db: PrismaClient, principal: Principal): TRPCContext {
  const unused = (what: string) => () => {
    throw new Error(`${what} is not used by placeOrder`);
  };
  return {
    now: () => NOW,
    principal,
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db: () => db,
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
async function guestWithHold(client: PrismaClient) {
  const sessionId = randomUUID().replaceAll("-", "");
  const principal: Principal = { kind: "guest", sessionId };
  const { eventId, seatIds } = await freeSeats(client, 1);
  const hold = await createBookingService({
    db: client,
    clock: { now: () => NOW },
    newId: randomUUID,
  }).holdSeats({ sessionId, buyerKey: sessionId }, eventId, seatIds);
  return { principal, hold };
}

describe("booking.placeOrder errors", () => {
  test("a saturated database is TOO_MANY_REQUESTS with BOOKING_BUSY", async () => {
    const { principal, hold } = await guestWithHold(db());
    const tight = open({ poolMax: 1, acquireTimeoutMs: 300 });
    // occupy opens the pool's only connection itself, retrying a slow first connect, so the
    // short acquire timeout below only ever meets a full pool.
    const occupation = await occupy(tight);
    let error: unknown;
    try {
      error = await failureOf(
        createCaller(contextFor(tight, principal)).booking.placeOrder({
          holdId: hold.id,
          contact: CONTACT,
          idempotencyKey: randomUUID(),
        }),
      );
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

  test("a statement cancelled by another session is INTERNAL_SERVER_ERROR with 57014 in its cause", async () => {
    const { principal, hold } = await guestWithHold(db());
    const idempotencyKey = randomUUID();
    const lockKey = Math.floor(Math.random() * 1_000_000_000);
    // placeOrder's order insert waits on a lock the test holds, until the test cancels it.
    await withTrigger(
      db(),
      {
        table: "orders",
        timing: "BEFORE INSERT",
        when: `NEW."idempotencyKey" = '${idempotencyKey}'`,
        body: `PERFORM pg_advisory_xact_lock(${lockKey});`,
      },
      async () => {
        const blocker = await block(
          db(),
          (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`,
          { what: "the test's latch lock" },
        );
        try {
          const call = createCaller(contextFor(db(), principal)).booking.placeOrder({
            holdId: hold.id,
            contact: CONTACT,
            idempotencyKey,
          });
          call.catch(() => undefined);
          const [waiting] = await waitUntilBlocked(db(), blocker.pid, {
            what: "placeOrder's order insert waiting on the test's lock",
            against: call,
          });
          if (waiting === undefined) {
            throw new Error("no backend waits on the test's lock");
          }
          await db().$queryRaw`SELECT pg_cancel_backend(${waiting.pid}::int)`;

          const error = await failureOf(call);

          expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
          expect(postgresErrorOf(error)).toEqual({
            code: "57014",
            message: "canceling statement due to user request",
          });
        } finally {
          await blocker.release();
        }
      },
    );
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
      const ctx = await createTRPCContextFactory({
        timeouts: runtime.timeouts,
        db: () => runtime.db,
      })({
        req: new Request("https://ticketarena.example/api/trpc"),
        resHeaders: new Headers(),
      });
      const sessionId = randomUUID().replaceAll("-", "");
      const { eventId, seatIds } = await freeSeats(runtime.db, 1);
      const event = { id: eventId };
      const seat = { id: seatIds[0] ?? "" };
      await withTrigger(
        runtime.db,
        {
          table: "seats",
          timing: "AFTER UPDATE",
          when: `NEW.id = '${seat.id}'::uuid`,
          scratch: "lock text, statement text",
          body: `INSERT INTO $scratch VALUES (current_setting('lock_timeout'), current_setting('statement_timeout'));`,
        },
        async (trigger) => {
          await bookingServiceFor({ ...ctx, now: () => NOW }).holdSeats(
            { sessionId, buyerKey: sessionId },
            event.id,
            [seat.id],
          );

          const recorded = await runtime.db.$queryRawUnsafe<unknown[]>(
            `SELECT lock, statement FROM ${trigger.scratch}`,
          );
          expect(recorded).toEqual([{ lock: "1234ms", statement: "4321ms" }]);
        },
      );
    } finally {
      await runtime.db.$disconnect();
    }
  });
});
