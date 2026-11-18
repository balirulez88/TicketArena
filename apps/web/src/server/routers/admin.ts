import type { BookingMetricCounts } from "@ticketarena/booking";
import { z } from "zod";
import { adminProcedure, createTRPCRouter, type TRPCContext } from "../trpc";

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
});
