import { randomUUID } from "node:crypto";
import {
  createQueueService,
  createScheduleAdmissionPolicy,
  type QueueService,
  RedisUnavailableError,
} from "@ticketarena/waiting-room";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure, type TRPCContext } from "../trpc";
import { eventNotFound } from "./event-not-found";

/**
 * Admissions per second assumed for the ETA. The ticker's real rate is worker configuration
 * (`ADMIT_RATE_PER_SECOND`, default 10); the web app does not read it yet.
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
  // A result, not an error: the page shows when the queue opens.
  z.object({ status: z.literal("NOT_OPEN"), queueOpensAt: z.date() }),
  z.object({ status: z.literal("ADMISSIBLE") }),
  // The session already holds a slot; the join changed nothing.
  z.object({ status: z.literal("ADMITTED") }),
]);

const statusOutput = z.discriminatedUnion("status", [
  queuedOutput,
  z.object({ status: z.literal("ADMITTED") }),
  z.object({ status: z.literal("NOT_QUEUED") }),
]);

const leaveOutput = z.object({ left: z.boolean() });

// Built per request so the clock and randomness always come from the request context.
export async function queueServiceFor(
  ctx: Pick<TRPCContext, "now" | "queueStore" | "random">,
): Promise<QueueService> {
  return createQueueService({
    store: await ctx.queueStore(),
    policy: createScheduleAdmissionPolicy(),
    clock: { now: ctx.now },
    random: ctx.random,
    newId: randomUUID,
    admitRatePerSecond: DEFAULT_ADMIT_RATE_PER_SECOND,
  });
}

/**
 * A Redis outage fails a queue call fast (the client's timeouts bound it) and says so, instead of
 * an opaque internal error: the page can tell the buyer to retry. Nothing is admitted meanwhile.
 */
async function orUnavailable<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RedisUnavailableError) {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "The waiting room is unavailable right now; try again shortly",
        cause: error,
      });
    }
    throw error;
  }
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
      return orUnavailable(async () =>
        (await queueServiceFor(ctx)).join(event, ctx.principal.sessionId),
      );
    }),

  // Minting here, on the poll after admission, is what hands the ticker's admission to the
  // browser (ADR 0008). Every ADMITTED poll re-issues the same claims, so a lost response or a
  // cleared cookie is repaired by the next poll; exp stays admittedAt + 30 min.
  status: publicProcedure
    .input(queueInput)
    .output(statusOutput)
    .query(async ({ ctx, input }) => {
      const sessionId = ctx.principal.sessionId;
      const result = await orUnavailable(async () =>
        (await queueServiceFor(ctx)).status(input.eventId, sessionId),
      );
      if (result.status !== "ADMITTED") {
        return result;
      }
      await ctx.admissionTokens.issue({ sessionId, eventId: input.eventId, ...result.admission });
      return { status: "ADMITTED" as const };
    }),

  leave: publicProcedure
    .input(queueInput)
    .output(leaveOutput)
    .mutation(({ ctx, input }) =>
      orUnavailable(async () =>
        (await queueServiceFor(ctx)).leave(input.eventId, ctx.principal.sessionId),
      ),
    ),
});
