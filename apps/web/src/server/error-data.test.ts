import {
  BookingBusyError,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  HoldSeatSetMissingError,
  IdempotencyKeyReusedError,
  InvalidSeatSelectionError,
  LimitExceededError,
  MixedCurrencyError,
  NotDemoEventError,
  NotOnSaleError,
  ResetBlockedError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import { createTRPCClient, httpLink } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import superjson from "superjson";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { rejectionOf, WIRE_URL, wireFetch } from "./testing/wire-client";
import { createTRPCContext, createTRPCRouter, publicProcedure } from "./trpc";

const SEAT_A = "55555555-5555-4555-8555-555555555555";
const SEAT_B = "66666666-6666-4666-8666-666666666666";
const HOLD_ID = "77777777-7777-4777-8777-777777777777";

/** Every domain error a router maps, under the tRPC code its router gives it. */
const mapped = {
  SEAT_UNAVAILABLE: () =>
    new TRPCError({
      code: "CONFLICT",
      message: "x",
      cause: new SeatUnavailableError([SEAT_A, SEAT_B]),
    }),
  LIMIT_EXCEEDED: () =>
    new TRPCError({ code: "CONFLICT", message: "x", cause: new LimitExceededError(5, 2) }),
  BOOKING_BUSY: () =>
    new TRPCError({ code: "TOO_MANY_REQUESTS", message: "x", cause: new BookingBusyError() }),
  INVALID_SEAT_SELECTION: () =>
    new TRPCError({
      code: "BAD_REQUEST",
      message: "x",
      cause: new InvalidSeatSelectionError("seatIds is empty"),
    }),
  NOT_ON_SALE: () =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "x",
      cause: new NotOnSaleError(HOLD_ID, new Date("2027-03-01T12:00:00.000Z")),
    }),
  NOT_FOUND: () =>
    new TRPCError({ code: "NOT_FOUND", message: "x", cause: new HoldNotFoundError(HOLD_ID) }),
  HOLD_EXPIRED: () =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "x",
      cause: new HoldExpiredError(HOLD_ID),
    }),
  HOLD_NOT_ACTIVE: () =>
    new TRPCError({
      code: "CONFLICT",
      message: "x",
      cause: new HoldNotActiveError(HOLD_ID, "ORDERED"),
    }),
  HOLD_SEAT_SET_MISSING: () =>
    new TRPCError({ code: "CONFLICT", message: "x", cause: new HoldSeatSetMissingError(HOLD_ID) }),
  MIXED_CURRENCY: () =>
    new TRPCError({
      code: "CONFLICT",
      message: "x",
      cause: new MixedCurrencyError(["EUR", "HUF"]),
    }),
  IDEMPOTENCY_KEY_REUSED: () =>
    new TRPCError({ code: "CONFLICT", message: "x", cause: new IdempotencyKeyReusedError("key") }),
  RESET_BLOCKED: () =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "x",
      cause: new ResetBlockedError("an order is still pending"),
    }),
  NOT_DEMO_EVENT: () =>
    new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "x",
      cause: new NotDemoEventError(HOLD_ID),
    }),
} as const;

type MappedCode = keyof typeof mapped;
const mappedCodes = Object.keys(mapped).filter((code): code is MappedCode => code in mapped);

/** A secret Prisma-like failure: it has a `code`, but it is not a domain error. */
function internalFailure(): Error {
  return Object.assign(new Error("connection to db.internal:5432 refused"), { code: "P1001" });
}

const router = createTRPCRouter({
  mapped: publicProcedure.input(z.object({ code: z.enum(mappedCodes) })).mutation(({ input }) => {
    throw mapped[input.code]();
  }),
  plain: publicProcedure.mutation(() => {
    throw new TRPCError({ code: "FORBIDDEN", message: "No valid admission" });
  }),
  wrapped: publicProcedure.mutation(() => {
    throw new TRPCError({ code: "CONFLICT", message: "x", cause: internalFailure() });
  }),
  unmapped: publicProcedure.mutation(() => {
    throw new SeatUnavailableError([SEAT_A]);
  }),
  crashed: publicProcedure.mutation(() => {
    throw internalFailure();
  }),
});

const client = createTRPCClient<typeof router>({
  links: [
    httpLink({
      url: WIRE_URL,
      transformer: superjson,
      fetch: wireFetch(router, createTRPCContext),
    }),
  ],
});

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@db.example.com/ticketarena?sslmode=require");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("error data on the wire", () => {
  test.each(mappedCodes)("a mapped %s carries its domain code", async (code) => {
    const error = await rejectionOf<typeof router>(client.mapped.mutate({ code }));

    expect(error.data?.domainCode).toBe(code);
    expect(error.data?.code).toBe(mapped[code]().code);
  });

  test("SEAT_UNAVAILABLE carries the taken seat ids, and no other domain error has seat ids", async () => {
    const taken = await rejectionOf<typeof router>(
      client.mapped.mutate({ code: "SEAT_UNAVAILABLE" }),
    );
    const limit = await rejectionOf<typeof router>(
      client.mapped.mutate({ code: "LIMIT_EXCEEDED" }),
    );

    expect(taken.data?.seatIds).toEqual([SEAT_A, SEAT_B]);
    expect(limit.data).not.toHaveProperty("seatIds");
  });

  test("an error that is not a domain error carries no domain code", async () => {
    for (const call of [() => client.plain.mutate(), () => client.wrapped.mutate()]) {
      const error = await rejectionOf<typeof router>(call());

      expect(error.data).not.toHaveProperty("domainCode");
      expect(error.data).not.toHaveProperty("seatIds");
    }
  });

  test("an unexpected failure reaches the client as a generic message, never its own", async () => {
    for (const call of [() => client.crashed.mutate(), () => client.unmapped.mutate()]) {
      const error = await rejectionOf<typeof router>(call());

      expect(error.data?.code).toBe("INTERNAL_SERVER_ERROR");
      expect(error.message).toBe("Internal server error");
      expect(JSON.stringify(error)).not.toContain("db.internal");
    }
  });

  test("a deliberate error keeps its own message on the wire", async () => {
    const error = await rejectionOf<typeof router>(client.plain.mutate());

    expect(error.message).toBe("No valid admission");
  });

  test("a domain error no router mapped is an internal error without a domain code", async () => {
    const error = await rejectionOf<typeof router>(client.unmapped.mutate());

    expect(error.data?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.data).not.toHaveProperty("domainCode");
    expect(error.data).not.toHaveProperty("seatIds");
  });

  test("data holds only the tRPC code, status, path and domain fields: never a stack or a cause", async () => {
    for (const call of [
      () => client.crashed.mutate(),
      () => client.wrapped.mutate(),
      () => client.mapped.mutate({ code: "SEAT_UNAVAILABLE" }),
    ]) {
      const error = await rejectionOf<typeof router>(call());

      expect(Object.keys(error.data ?? {}).sort()).toEqual(
        expect.arrayContaining(["code", "httpStatus", "path"]),
      );
      expect(
        Object.keys(error.data ?? {}).filter(
          (key) => !["code", "httpStatus", "path", "domainCode", "seatIds"].includes(key),
        ),
      ).toEqual([]);
      expect(JSON.stringify(error.data)).not.toContain("db.internal");
      expect(JSON.stringify(error.data)).not.toContain("P1001");
    }
  });
});
