import {
  BookingBusyError,
  type Buyer,
  HoldExpiredError,
  HoldNotActiveError,
  HoldNotFoundError,
  HoldSeatSetMissingError,
  IdempotencyKeyReusedError,
  InvalidSeatSelectionError,
  LimitExceededError,
  MAX_SEATS_PER_BUYER,
  MixedCurrencyError,
  NotOnSaleError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import type { QueueService } from "@ticketarena/waiting-room";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { buyerKey, type Principal } from "../identity/identity";
import {
  admittedProcedure,
  bookingServiceFor,
  createTRPCRouter,
  publicProcedure,
  type TRPCContext,
} from "../trpc";
import { queueServiceFor } from "./queue";

// `eventId` is what admission is checked against; the booking core refuses any seat not of that
// event, so an admission to one event can never hold another event's seats.
const holdSeatsInput = z.object({
  eventId: z.uuid(),
  seatIds: z.array(z.uuid()).min(1).max(MAX_SEATS_PER_BUYER),
});

const getHoldInput = z.object({ holdId: z.uuid() });

const releaseHoldInput = z.object({ holdId: z.uuid() });

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

// Best-effort by design: a waiting-room slot is Redis bookkeeping and never decides seat or order
// state (ADR 0005, ADR 0008), so a Redis failure must not fail a hold or an already committed
// order. A slot left behind is freed by the reaper once it goes idle or its admission expires.
async function onSlot(
  ctx: TRPCContext,
  action: string,
  touch: (queue: QueueService) => Promise<unknown>,
): Promise<void> {
  try {
    await touch(await queueServiceFor(ctx));
  } catch (error) {
    ctx.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      `waiting-room ${action} failed; the reaper will free the slot`,
    );
  }
}

export const bookingRouter = createTRPCRouter({
  holdSeats: admittedProcedure
    .input(holdSeatsInput)
    .output(holdOutput)
    .mutation(async ({ ctx, input }) => {
      // holdSeats is the admitted call (ADR 0008): it counts as activity for the buyer's slot.
      await onSlot(ctx, "heartbeat", (queue) =>
        queue.heartbeat(input.eventId, ctx.principal.sessionId),
      );
      const booking = bookingServiceFor(ctx);
      try {
        return await booking.holdSeats(toBuyer(ctx.principal), input.eventId, input.seatIds);
      } catch (error) {
        if (error instanceof SeatUnavailableError || error instanceof LimitExceededError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message, cause: error });
        }
        if (error instanceof BookingBusyError) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message, cause: error });
        }
        if (error instanceof InvalidSeatSelectionError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
        }
        if (error instanceof NotOnSaleError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error.message,
            cause: error,
          });
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

  // Owner-only and HELD-only; does not touch the buyer's waiting-room slot.
  releaseHold: publicProcedure
    .input(releaseHoldInput)
    .output(holdOutput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await bookingServiceFor(ctx).releaseHold(toBuyer(ctx.principal), input.holdId);
      } catch (error) {
        if (error instanceof HoldNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: error.message, cause: error });
        }
        if (error instanceof HoldNotActiveError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message, cause: error });
        }
        throw error;
      }
    }),

  placeOrder: publicProcedure
    .input(placeOrderInput)
    .output(orderOutput)
    .mutation(async ({ ctx, input }) => {
      const booking = bookingServiceFor(ctx);
      const buyer = toBuyer(ctx.principal);
      try {
        const order = await booking.placeOrder(
          buyer,
          input.holdId,
          input.contact,
          input.idempotencyKey,
        );
        // Only after the order has committed: the buyer is done shopping, so the slot goes to the
        // next buyer in the queue. A replayed placeOrder frees an already free slot, a no-op.
        await onSlot(ctx, "slot release", async (queue) => {
          const hold = await booking.getHold(buyer, order.holdId);
          if (hold !== null) {
            await queue.releaseSlot(hold.eventId, ctx.principal.sessionId);
          }
        });
        return order;
      } catch (error) {
        if (error instanceof HoldNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: error.message, cause: error });
        }
        if (error instanceof BookingBusyError) {
          throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message, cause: error });
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
          error instanceof HoldSeatSetMissingError ||
          error instanceof MixedCurrencyError ||
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
