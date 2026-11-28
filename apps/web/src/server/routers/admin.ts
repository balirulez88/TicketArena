import { randomUUID } from "node:crypto";
import {
  BookingBusyError,
  type BookingMetricCounts,
  type HoldView,
  NotDemoEventError,
  RefundNotInManualReviewError,
  RefundObligationNotFoundError,
  ResetBlockedError,
  SeatUnavailableError,
} from "@ticketarena/booking";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { measureOutboxLags, OUTBOX_SERVICES, readOutboxFeed } from "../admin/outbox-feed";
import {
  adminProcedure,
  bookingServiceFor,
  createTRPCRouter,
  optionalMetrics,
  type TRPCContext,
} from "../trpc";
import { type DeliveryFigures, deliveryFiguresSchema } from "../worker-health";

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
  deadlock_retry: count,
  limit_exceeded: count,
  late_delivery_refund: count,
});

const perService = z.object({ booking: count, payment: count, notification: count });

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
  messageHealth: z.object({
    /** Oldest `PENDING` age per service outbox, in ms, read from Postgres. */
    outboxLagMs: perService,
    /**
     * Consumer lag, pending acks, redeliveries and the DLQ's size and oldest age, from the
     * worker's `/health`; `null` when the worker cannot be read or is not configured.
     */
    delivery: deliveryFiguresSchema.nullable(),
  }),
  /** `refund_pending_age_max`: ms since the oldest open refund obligation's first request. */
  refundPendingAgeMaxMs: count,
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
  deadlock_retry: 0,
  limit_exceeded: 0,
  late_delivery_refund: 0,
};

/** Best-effort like the counters: the worker being away never fails the snapshot. */
async function readDelivery(
  ctx: Pick<TRPCContext, "workerHealth" | "logger">,
): Promise<DeliveryFigures | null> {
  try {
    return await ctx.workerHealth().read();
  } catch (error) {
    ctx.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "admin snapshot: worker health unavailable",
    );
    return null;
  }
}

const FEED_MAX_LIMIT = 200;

const feedCursor = z.object({ createdAt: z.date(), id: z.uuid() });

const feedInput = z.object({
  /** Entries strictly after it; without one, the newest `limit` entries. */
  cursor: feedCursor.optional(),
  limit: z.number().int().min(1).max(FEED_MAX_LIMIT).default(50),
  /** Only one booking's saga. */
  correlationId: z.uuid().optional(),
});

const feedOutput = z.object({
  entries: z.array(
    z.object({
      id: z.uuid(),
      service: z.enum(OUTBOX_SERVICES),
      eventType: z.string(),
      aggregateType: z.string(),
      aggregateId: z.string(),
      correlationId: z.string().nullable(),
      status: z.enum(["PENDING", "PUBLISHED", "FAILED"]),
      createdAt: z.date(),
      publishedAt: z.date().nullable(),
    }),
  ),
  /** Pass it back to read what came after; the input cursor again when nothing did. */
  nextCursor: feedCursor.nullable(),
});

export type AdminFeedPage = z.infer<typeof feedOutput>;

const STUCK_REFUNDS_MAX_LIMIT = 500;

const openRefund = z.object({
  paymentId: z.uuid(),
  orderId: z.uuid(),
  amount: count,
  currency: z.string(),
  status: z.enum(["REFUND_REQUESTED", "MANUAL_REVIEW"]),
  refundAttempts: count,
  refundRequestedAt: z.date(),
  refundLastRequestedAt: z.date(),
  orphan: z.boolean(),
  ageMs: count,
});

export type StuckRefund = z.infer<typeof openRefund>;

const retriedRefund = openRefund.omit({ orphan: true, ageMs: true }).extend({
  status: z.literal("REFUND_REQUESTED"),
});

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
  const demos = await ctx.db().event.findMany({ where: { demo: true }, select: { id: true } });
  const [demo] = demos;
  if (demo === undefined || demos.length > 1) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `expected exactly one demo event, found ${demos.length}`,
    });
  }
  return demo.id;
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
      ctx.db().event.findMany({
        select: { id: true, name: true, demo: true },
        orderBy: { onSaleAt: "asc" },
      }),
      ctx.db().seat.groupBy({ by: ["eventId", "status"], _count: { _all: true } }),
      ctx.db().order.groupBy({ by: ["status"], _count: { _all: true } }),
      ctx.queueStore(),
    ]);
    const eventIds = events.map((event) => event.id);
    const [queueCounts, metrics, outboxLagMs, delivery, refundPendingAgeMaxMs] = await Promise.all([
      Promise.all(eventIds.map((eventId) => store.counts(eventId))),
      readMetrics(ctx, eventIds),
      measureOutboxLags(ctx.db(), takenAt),
      readDelivery(ctx),
      bookingServiceFor(ctx).refundPendingAgeMax(),
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
      messageHealth: { outboxLagMs, delivery },
      refundPendingAgeMaxMs,
    };
  }),

  /**
   * The live feed: every service's outbox rows by `(createdAt, id)` (ADR 0009), metadata only.
   * The dashboard polls it with the last `nextCursor` and groups entries by `correlationId`.
   */
  feed: adminProcedure
    .input(feedInput.default({ limit: 50 }))
    .output(feedOutput)
    .query(async ({ ctx, input }) => {
      const entries = await readOutboxFeed(ctx.db(), {
        after: input.cursor,
        limit: input.limit,
        correlationId: input.correlationId,
      });
      const last = entries.at(-1);
      return {
        entries,
        nextCursor:
          last === undefined ? (input.cursor ?? null) : { createdAt: last.createdAt, id: last.id },
      };
    }),

  /** Open refund obligations, oldest first request first, each with its age. */
  stuckRefunds: adminProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(STUCK_REFUNDS_MAX_LIMIT).default(100) })
        .default({ limit: 100 }),
    )
    .output(z.array(openRefund))
    .query(({ ctx, input }) => bookingServiceFor(ctx).openRefunds(input.limit)),

  /**
   * The operator's "retry refund" for a `MANUAL_REVIEW` obligation (`BookingService.retryRefund`):
   * re-emitted through the outbox with a fresh re-emit budget, its first request time kept.
   */
  retryRefund: adminProcedure
    .input(z.object({ paymentId: z.uuid() }))
    .output(retriedRefund)
    .mutation(async ({ ctx, input }) => {
      try {
        const retried = await bookingServiceFor(ctx).retryRefund(input.paymentId);
        return { ...retried, status: "REFUND_REQUESTED" as const };
      } catch (error) {
        if (error instanceof RefundObligationNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: error.message, cause: error });
        }
        if (error instanceof RefundNotInManualReviewError) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error.message,
            cause: error,
          });
        }
        throw error;
      }
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
    const seat = await ctx.db().seat.findFirst({
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
