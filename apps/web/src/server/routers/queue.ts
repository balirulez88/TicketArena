import {
  createQueueService,
  createScheduleAdmissionPolicy,
  type QueueService,
} from "@ticketarena/waiting-room";
import { z } from "zod";
import { createTRPCRouter, publicProcedure, type TRPCContext } from "../trpc";
import { eventNotFound } from "./event-not-found";

/**
 * Admissions per second assumed for the ETA until the admission ticker (ticket 30) makes the
 * rate configurable per event.
 */
export const DEFAULT_ADMIT_RATE_PER_SECOND = 10;

const queueInput = z.object({ eventId: z.uuid() });

const queuedOutput = z.object({
  status: z.literal("QUEUED"),
  position: z.number().int().positive(),
  etaSeconds: z.number().int().nonnegative(),
});

const joinOutput = z.discriminatedUnion("status", [
  queuedOutput,
  z.object({ status: z.literal("ADMISSIBLE") }),
]);

const statusOutput = z.discriminatedUnion("status", [
  queuedOutput,
  z.object({ status: z.literal("NOT_QUEUED") }),
]);

const leaveOutput = z.object({ left: z.boolean() });

// Built per request so the clock and randomness always come from the request context.
async function queueServiceFor(ctx: TRPCContext): Promise<QueueService> {
  return createQueueService({
    store: await ctx.queueStore(),
    policy: createScheduleAdmissionPolicy(),
    clock: { now: ctx.now },
    random: ctx.random,
    admitRatePerSecond: DEFAULT_ADMIT_RATE_PER_SECOND,
  });
}

/** Queue membership is per session (ADR 0008: the admission token's `sub` is the session id). */
export const queueRouter = createTRPCRouter({
  join: publicProcedure
    .input(queueInput)
    .output(joinOutput)
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { id: input.eventId },
        select: { id: true, onSaleAt: true, queueOpensAt: true, queueClosesAt: true },
      });
      if (event === null) {
        throw eventNotFound(input.eventId);
      }
      return (await queueServiceFor(ctx)).join(event, ctx.principal.sessionId);
    }),

  status: publicProcedure
    .input(queueInput)
    .output(statusOutput)
    .query(async ({ ctx, input }) =>
      (await queueServiceFor(ctx)).status(input.eventId, ctx.principal.sessionId),
    ),

  leave: publicProcedure
    .input(queueInput)
    .output(leaveOutput)
    .mutation(async ({ ctx, input }) =>
      (await queueServiceFor(ctx)).leave(input.eventId, ctx.principal.sessionId),
    ),
});
