import { randomUUID } from "node:crypto";
import {
  type Buyer,
  createBookingService,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  IdempotencyKeyReusedError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import type { PrismaClient } from "@ticketarena/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { buyerKey, type Principal } from "../identity/identity";
import { createTRPCRouter, publicProcedure } from "../trpc";

const holdSeatsInput = z.object({
  eventId: z.uuid(),
  // One seat until the waiting room and the 6-ticket limit land.
  seatIds: z.array(z.uuid()).length(1),
});

const getHoldInput = z.object({ holdId: z.uuid() });

const placeOrderInput = z.object({
  holdId: z.uuid(),
  contact: z.object({ email: z.email(), phone: z.string().trim().min(1).max(32).optional() }),
  idempotencyKey: z.uuid(),
});

const getOrderInput = z.object({ orderId: z.uuid() });

const orderOutput = z.object({
  id: z.uuid(),
  holdId: z.uuid(),
  status: z.enum(["PENDING_PAYMENT", "CONFIRMED", "CANCELLED", "EXPIRED"]),
  totalMinor: z.number().int(),
  currency: z.string(),
  paymentDeadline: z.date(),
  correlationId: z.uuid(),
  contact: z.object({ email: z.string(), phone: z.string().optional() }),
  lines: z.array(
    z.object({ seatId: z.uuid(), priceMinor: z.number().int(), currency: z.string() }),
  ),
});

const holdOutput = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  seatIds: z.array(z.uuid()),
  status: z.enum(["HELD", "ORDERED", "RELEASED", "EXPIRED"]),
  holdExpiresAt: z.date(),
  correlationId: z.uuid(),
});

function toBuyer(principal: Principal): Buyer {
  return {
    sessionId: principal.sessionId,
    ...(principal.kind === "user" ? { userId: principal.userId } : {}),
    buyerKey: buyerKey(principal),
  };
}

// Built per request so the injected clock and db always come from the request context.
function bookingServiceFor(ctx: { db: PrismaClient; now: () => Date }) {
  return createBookingService({ db: ctx.db, clock: { now: ctx.now }, newId: randomUUID });
}

export const bookingRouter = createTRPCRouter({
  holdSeats: publicProcedure
    .input(holdSeatsInput)
    .output(holdOutput)
    .mutation(async ({ ctx, input }) => {
      const booking = bookingServiceFor(ctx);
      try {
        return await booking.holdSeats(toBuyer(ctx.principal), input.eventId, input.seatIds);
      } catch (error) {
        if (error instanceof SeatUnavailableError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message, cause: error });
        }
        throw error;
      }
    }),

  getHold: publicProcedure
    .input(getHoldInput)
    .output(holdOutput)
    .query(async ({ ctx, input }) => {
      const booking = bookingServiceFor(ctx);
      const hold = await booking.getHold(toBuyer(ctx.principal), input.holdId);
      if (hold === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Hold ${input.holdId} not found` });
      }
      return hold;
    }),

  placeOrder: publicProcedure
    .input(placeOrderInput)
    .output(orderOutput)
    .mutation(async ({ ctx, input }) => {
      const booking = bookingServiceFor(ctx);
      try {
        return await booking.placeOrder(
          toBuyer(ctx.principal),
          input.holdId,
          input.contact,
          input.idempotencyKey,
        );
      } catch (error) {
        if (error instanceof HoldNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: error.message, cause: error });
        }
        if (error instanceof HoldExpiredError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error.message,
            cause: error,
          });
        }
        if (
          error instanceof HoldNotActiveError ||
          error instanceof IdempotencyKeyReusedError ||
          error instanceof SeatUnavailableError
        ) {
          throw new TRPCError({ code: "CONFLICT", message: error.message, cause: error });
        }
        throw error;
      }
    }),

  getOrder: publicProcedure
    .input(getOrderInput)
    .output(orderOutput)
    .query(async ({ ctx, input }) => {
      const order = await bookingServiceFor(ctx).getOrder(toBuyer(ctx.principal), input.orderId);
      if (order === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Order ${input.orderId} not found` });
      }
      return order;
    }),
});
