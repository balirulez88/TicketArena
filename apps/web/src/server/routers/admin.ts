import { randomUUID } from "node:crypto";
import {
  BookingBusyError,
  type BookingMetricCounts,
  type BookingMetrics,
  type HoldView,
  NotDemoEventError,
  ResetBlockedError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, bookingServiceFor, createTRPCRouter, type TRPCContext } from "../trpc";

const count = z.number().int().nonnegative();

const seatsByStatus = z.object({
  AVAILABLE: count,
  HELD: count,
  IN_CHECKOUT: count,
  SOLD: count,
});

const ordersByStatus = z.object({
  PENDING_PAYMENT: count,
  CONFIRMED: count,
  CANCELLED: count,
  EXPIRED: count,
});

const bookingMetrics = z.object({
  hold_ok: count,
  seat_unavailable: count,
  race_lost: count,
  booking_busy: count,
  limit_exceeded: count,
});

const snapshotOutput = z.object({
  takenAt: z.date(),
  orders: ordersByStatus,
  /** Orders awaiting payment (`PENDING_PAYMENT`), read from booking's own table (ADR 0009). */
  pendingPayments: count,
  events: z.array(
    z.object({
      eventId: z.uuid(),
      name: z.string(),
      demo: z.boolean(),
      /** Stored status: a `HELD` seat whose hold has lapsed counts as held until the sweeper runs. */
      seats: seatsByStatus,
      queueLength: count,
      activeShoppers: count,
      /** `null` when the counters cannot be read: they are best-effort and never block the rest. */
      metrics: bookingMetrics.nullable(),
    }),
  ),
});

export type AdminSnapshot = z.infer<typeof snapshotOutput>;

async function readMetrics(
  ctx: Pick<TRPCContext, "metricsReader" | "logger">,
  eventIds: readonly string[],
): Promise<ReadonlyMap<string, BookingMetricCounts> | undefined> {
  try {
    const reader = ctx.metricsReader();
    const counts = await Promise.all(eventIds.map((eventId) => reader.read(eventId)));
    return new Map(eventIds.map((eventId, i) => [eventId, counts[i] ?? emptyMetrics]));
  } catch (error) {
    ctx.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "admin snapshot: metrics unavailable",
    );
    return undefined;
  }
}

const emptyMetrics: BookingMetricCounts = {
  hold_ok: 0,
  seat_unavailable: 0,
  race_lost: 0,
  booking_busy: 0,
  limit_exceeded: 0,
};

/** The spec's race size: synthetic buyers that try to hold the same seat at once. */
export const RACE_BUYERS = 100;

const raceOutput = z.object({
  eventId: z.uuid(),
  seatId: z.uuid(),
  buyers: count,
  successes: count,
  seatUnavailable: count,
  bookingBusy: count,
  /** Anything else a hold attempt threw; a healthy race reports 0. */
  otherErrors: count,
  durationMs: count,
  /** The hold that won; its `seat.held` outbox event carries this correlation id. */
  winner: z.object({ holdId: z.uuid(), correlationId: z.uuid() }).nullable(),
});

export type RaceResult = z.infer<typeof raceOutput>;

const resetOutput = z.object({
  eventId: z.uuid(),
  /** Holds that never became an order. */
  holdsDeleted: count,
  /** Orders left in place with their lines and ledger rows: the reset never deletes money's trail. */
  ordersKept: count,
  seatsFreed: count,
});

export type ResetDemoResult = z.infer<typeof resetOutput>;

/** Checked before any work, so a refused call has no effect at all. */
async function rateLimit(ctx: Pick<TRPCContext, "rateLimiter">, action: string): Promise<void> {
  const decision = await ctx.rateLimiter().acquire(action);
  if (!decision.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `admin.${action} is limited to 1 per 10 s; retry in ${Math.ceil(decision.retryAfterMs / 1000)} s`,
    });
  }
}

/**
 * The event the destructive actions may touch is chosen here, never by the caller, so no input
 * can point them at a real event. Exactly one demo event is required: two would be ambiguous.
 */
async function demoEventId(ctx: Pick<TRPCContext, "db">): Promise<string> {
  const demos = await ctx.db.event.findMany({ where: { demo: true }, select: { id: true } });
  const [demo] = demos;
  if (demo === undefined || demos.length > 1) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `expected exactly one demo event, found ${demos.length}`,
    });
  }
  return demo.id;
}

/** Counters are best-effort: a race still runs, uncounted, when they are not configured. */
function optionalMetrics(ctx: Pick<TRPCContext, "metrics">): BookingMetrics | undefined {
  try {
    return ctx.metrics();
  } catch {
    return undefined;
  }
}

type RaceOutcome =
  | { readonly kind: "held"; readonly hold: HoldView }
  | { readonly kind: "seatUnavailable" | "bookingBusy" | "other" };

export const adminRouter = createTRPCRouter({
  /**
   * The dashboard's live figures across every event. Seat and order counts come from Postgres, the
   * authority; queue figures and counters from Redis. The reads are not one transaction: each
   * figure is current, but they may be a few milliseconds apart.
   */
  snapshot: adminProcedure.output(snapshotOutput).query(async ({ ctx }) => {
    const takenAt = ctx.now();
    const [events, seatGroups, orderGroups, store] = await Promise.all([
      ctx.db.event.findMany({
        select: { id: true, name: true, demo: true },
        orderBy: { onSaleAt: "asc" },
      }),
      ctx.db.seat.groupBy({ by: ["eventId", "status"], _count: { _all: true } }),
      ctx.db.order.groupBy({ by: ["status"], _count: { _all: true } }),
      ctx.queueStore(),
    ]);
    const eventIds = events.map((event) => event.id);
    const [queueCounts, metrics] = await Promise.all([
      Promise.all(eventIds.map((eventId) => store.counts(eventId))),
      readMetrics(ctx, eventIds),
    ]);

    const orders = { PENDING_PAYMENT: 0, CONFIRMED: 0, CANCELLED: 0, EXPIRED: 0 };
    for (const group of orderGroups) {
      orders[group.status] = group._count._all;
    }

    return {
      takenAt,
      orders,
      pendingPayments: orders.PENDING_PAYMENT,
      events: events.map((event, i) => {
        const seats = { AVAILABLE: 0, HELD: 0, IN_CHECKOUT: 0, SOLD: 0 };
        for (const group of seatGroups) {
          if (group.eventId === event.id) {
            seats[group.status] = group._count._all;
          }
        }
        return {
          eventId: event.id,
          name: event.name,
          demo: event.demo,
          seats,
          queueLength: queueCounts[i]?.queued ?? 0,
          activeShoppers: queueCounts[i]?.active ?? 0,
          metrics: metrics?.get(event.id) ?? null,
        };
      }),
    };
  }),

  /**
   * 100 synthetic sessions call `BookingService.holdSeats` on one free demo seat at once,
   * in-process. Admission is bypassed on purpose: it is a tRPC concern, and the race exercises
   * the booking core's row locks (ADR 0005). Each session is a fresh buyer, so neither the buyer
   * lock nor the per-buyer limit serializes them.
   */
  runRace: adminProcedure.output(raceOutput).mutation(async ({ ctx }) => {
    await rateLimit(ctx, "runRace");
    const eventId = await demoEventId(ctx);
    const seat = await ctx.db.seat.findFirst({
      where: { eventId, status: "AVAILABLE" },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    if (seat === null) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "the demo event has no free seat; reset the demo first",
      });
    }
    const booking = bookingServiceFor(ctx, optionalMetrics(ctx));

    const startedAt = ctx.now();
    const outcomes = await Promise.all(
      Array.from({ length: RACE_BUYERS }, (): Promise<RaceOutcome> => {
        const sessionId = randomUUID().replaceAll("-", "");
        return booking.holdSeats({ sessionId, buyerKey: sessionId }, eventId, [seat.id]).then(
          (hold) => ({ kind: "held", hold }),
          (error: unknown) => {
            if (error instanceof SeatUnavailableError) {
              return { kind: "seatUnavailable" };
            }
            if (error instanceof BookingBusyError) {
              return { kind: "bookingBusy" };
            }
            ctx.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              "race hold failed unexpectedly",
            );
            return { kind: "other" };
          },
        );
      }),
    );
    const durationMs = ctx.now().getTime() - startedAt.getTime();

    const tally = (kind: RaceOutcome["kind"]) =>
      outcomes.filter((outcome) => outcome.kind === kind).length;
    const won = outcomes.find((outcome) => outcome.kind === "held");
    const result: RaceResult = {
      eventId,
      seatId: seat.id,
      buyers: RACE_BUYERS,
      successes: tally("held"),
      seatUnavailable: tally("seatUnavailable"),
      bookingBusy: tally("bookingBusy"),
      otherErrors: tally("other"),
      durationMs,
      winner:
        won?.kind === "held"
          ? { holdId: won.hold.id, correlationId: won.hold.correlationId }
          : null,
    };
    ctx.logger.info({ ...result, winner: result.winner?.holdId ?? null }, "demo race finished");
    return result;
  }),

  /**
   * Frees the demo event's seats and queue so the demo can run again, keeping every order and its
   * ledger rows (see `BookingService.resetEvent`). Postgres goes first because it is the authority
   * (ADR 0005): if a Redis step then fails, the call fails and can simply be repeated, since a
   * reset of an already reset event is a no-op.
   */
  resetDemo: adminProcedure.output(resetOutput).mutation(async ({ ctx }) => {
    await rateLimit(ctx, "resetDemo");
    const eventId = await demoEventId(ctx);
    const booking = bookingServiceFor(ctx);
    let result: ResetDemoResult;
    try {
      result = await booking.resetEvent(eventId);
    } catch (error) {
      if (error instanceof ResetBlockedError || error instanceof NotDemoEventError) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
      }
      throw error;
    }
    await ctx.metricsReset().reset(eventId);
    await (await ctx.queueStore()).clearEvent(eventId);
    return result;
  }),
});
