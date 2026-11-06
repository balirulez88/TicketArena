import { createHash } from "node:crypto";
import {
  envelopeLogBindings,
  envelopeSchema,
  type Logger,
  orderPlacedPayloadSchema,
  seatHeldPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";

export interface Clock {
  now(): Date;
}

/** The slice of a Principal booking needs; identity details stay behind IdentityService. */
export interface Buyer {
  readonly sessionId: string;
  readonly userId?: string;
  readonly buyerKey: string;
}

export interface BookingServiceDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  /** Mints ids in the application so tests control them; never `gen_random_uuid()`. */
  readonly newId: () => string;
  /** Injected by the app; lines are bound to the booking's correlation, hold and order ids. */
  readonly logger?: Logger;
  /** Optional; counters are best-effort and never decide or fail a booking. */
  readonly metrics?: BookingMetrics;
}

export type BookingMetric =
  | "hold_ok"
  | "seat_unavailable"
  | "race_lost"
  | "booking_busy"
  | "limit_exceeded";

/** Per-event counters. Implementations may reject; the service logs and moves on. */
export interface BookingMetrics {
  increment(metric: BookingMetric, eventId: string): Promise<void>;
}

type HoldStatus = "HELD" | "ORDERED" | "RELEASED" | "EXPIRED";

export interface HoldView {
  readonly id: string;
  readonly eventId: string;
  readonly seatIds: string[];
  readonly status: HoldStatus;
  readonly holdExpiresAt: Date;
  readonly correlationId: string;
}

export interface Contact {
  readonly email: string;
  readonly phone?: string | undefined;
}

type OrderStatus = "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED" | "EXPIRED";

export interface OrderLineView {
  readonly seatId: string;
  readonly priceMinor: number;
  readonly currency: string;
}

export interface OrderView {
  readonly id: string;
  readonly holdId: string;
  readonly status: OrderStatus;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentDeadline: Date;
  readonly correlationId: string;
  readonly contact: Contact;
  readonly lines: OrderLineView[];
}

export interface BookingService {
  holdSeats(buyer: Buyer, eventId: string, seatIds: readonly string[]): Promise<HoldView>;
  /** `null` for an unknown hold and for someone else's: existence is not leaked. */
  getHold(buyer: Buyer, holdId: string): Promise<HoldView | null>;
  /** Idempotent per `(buyer.sessionId, idempotencyKey)`: a replay returns the original order. */
  placeOrder(
    buyer: Buyer,
    holdId: string,
    contact: Contact,
    idempotencyKey: string,
  ): Promise<OrderView>;
  /** `null` for an unknown order and for someone else's: existence is not leaked. */
  getOrder(buyer: Buyer, orderId: string): Promise<OrderView | null>;
}

export class HoldNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(holdId: string) {
    super(`NOT_FOUND: hold ${holdId}`);
    this.name = "HoldNotFoundError";
  }
}

export class HoldExpiredError extends Error {
  readonly code = "HOLD_EXPIRED";

  constructor(holdId: string) {
    super(`HOLD_EXPIRED: ${holdId}`);
    this.name = "HoldExpiredError";
  }
}

export class HoldNotActiveError extends Error {
  readonly code = "HOLD_NOT_ACTIVE";

  constructor(holdId: string, status: string) {
    super(`HOLD_NOT_ACTIVE: hold ${holdId} is ${status}`);
    this.name = "HoldNotActiveError";
  }
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor(idempotencyKey: string) {
    super(`IDEMPOTENCY_KEY_REUSED: ${idempotencyKey} was used for a different request`);
    this.name = "IdempotencyKeyReusedError";
  }
}

export class SeatUnavailableError extends Error {
  readonly code = "SEAT_UNAVAILABLE";

  constructor(readonly seatIds: readonly string[]) {
    super(`SEAT_UNAVAILABLE: ${seatIds.join(", ")}`);
    this.name = "SeatUnavailableError";
  }
}

/** The database could not take the request in time (pool or transaction start); retryable. */
export class BookingBusyError extends Error {
  readonly code = "BOOKING_BUSY";

  constructor(options?: { cause: unknown }) {
    super("BOOKING_BUSY: the booking system is saturated, retry shortly", options);
    this.name = "BookingBusyError";
  }
}

export class InvalidSeatSelectionError extends Error {
  readonly code = "INVALID_SEAT_SELECTION";

  constructor(reason: string) {
    super(`INVALID_SEAT_SELECTION: ${reason}`);
    this.name = "InvalidSeatSelectionError";
  }
}

/** The buyer would hold, be checking out or own more than MAX_SEATS_PER_BUYER seats of the event. */
export class LimitExceededError extends Error {
  readonly code = "LIMIT_EXCEEDED";

  constructor(
    readonly used: number,
    readonly requested: number,
  ) {
    super(
      `LIMIT_EXCEEDED: ${used} seat(s) in use plus ${requested} requested exceeds ${MAX_SEATS_PER_BUYER}`,
    );
    this.name = "LimitExceededError";
  }
}

/** The hold's `seat.held` event, the source of its seat set, no longer exists. */
export class HoldSeatSetMissingError extends Error {
  readonly code = "HOLD_SEAT_SET_MISSING";

  constructor(holdId: string) {
    super(`HOLD_SEAT_SET_MISSING: hold ${holdId} has no seat.held event`);
    this.name = "HoldSeatSetMissingError";
  }
}

export class MixedCurrencyError extends Error {
  readonly code = "MIXED_CURRENCY";

  constructor(currencies: readonly string[]) {
    super(`MIXED_CURRENCY: seats are priced in ${currencies.join(", ")}`);
    this.name = "MixedCurrencyError";
  }
}

/** Per buyer and event, counting held, in-checkout and sold seats exactly once. */
export const MAX_SEATS_PER_BUYER = 6;
const HOLD_DURATION_MS = 10 * 60_000;
const SEAT_HELD_EVENT = "seat.held";
const heldEnvelope = envelopeSchema(seatHeldPayloadSchema);
// Fixed at placement and never extended: the settlement grace absorbs lateness, not this value.
const PAYMENT_WINDOW_MS = 5 * 60_000;
const ORDER_PLACED_EVENT = "order.placed";
const placedEnvelope = envelopeSchema(orderPlacedPayloadSchema);
const PG_UNIQUE_VIOLATION = "P2002";

interface LockedHold {
  readonly buyerKey: string;
  readonly status: string;
  readonly holdExpiresAt: Date;
  readonly correlationId: string;
  readonly eventId: string;
}

interface PricedSeat {
  readonly id: string;
  readonly priceMinor: number;
  readonly currency: string;
}

const orderInclude = { lines: { orderBy: { seatId: "asc" } } } as const;

function assertPlaceable(
  holdId: string,
  hold: LockedHold,
  expectedSeatIds: readonly string[],
  seats: readonly { id: string; status: string; holdId: string | null }[],
  placedAt: Date,
): void {
  if (hold.status !== "HELD") {
    throw new HoldNotActiveError(holdId, hold.status);
  }
  if (placedAt.getTime() >= hold.holdExpiresAt.getTime()) {
    throw new HoldExpiredError(holdId);
  }
  // Defends against clock skew between instances: expiry alone is not proof the seats are ours.
  const intact = new Set(
    seats.filter((seat) => seat.status === "HELD" && seat.holdId === holdId).map((s) => s.id),
  );
  const lost = expectedSeatIds.filter((id) => !intact.has(id));
  if (expectedSeatIds.length === 0 || lost.length > 0) {
    throw new SeatUnavailableError(lost);
  }
}

/** Prices exactly `seatIds`, the validated and locked set, never whatever carries the holdId. */
async function priceSeats(
  tx: Pick<PrismaClient, "$queryRaw">,
  seatIds: readonly string[],
): Promise<{ priced: PricedSeat[]; totalMinor: number; currency: string }> {
  const priced = await tx.$queryRaw<PricedSeat[]>`
    SELECT s.id::text AS id, sec."priceMinor", sec.currency
    FROM seats s
    JOIN rows r ON r.id = s."rowId"
    JOIN sections sec ON sec.id = r."sectionId"
    WHERE s.id = ANY(${[...seatIds]}::uuid[])
    ORDER BY s.id`;
  const currencies = [...new Set(priced.map((seat) => seat.currency))];
  const [currency] = currencies;
  // No fallback: an empty set (unreachable after assertPlaceable) or a mix has no honest currency.
  if (currency === undefined || currencies.length > 1) {
    throw new MixedCurrencyError(currencies);
  }
  return { priced, totalMinor: priced.reduce((sum, seat) => sum + seat.priceMinor, 0), currency };
}

interface OrderPlacedFacts {
  readonly orderId: string;
  readonly holdId: string;
  readonly correlationId: string;
  readonly placedAt: Date;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentDeadline: Date;
  readonly contact: Contact;
}

function orderPlacedEnvelope(eventId: string, facts: OrderPlacedFacts) {
  return placedEnvelope.parse({
    id: eventId,
    type: ORDER_PLACED_EVENT,
    version: 1,
    occurredAt: facts.placedAt.toISOString(),
    correlationId: facts.correlationId,
    causationId: null,
    holdId: facts.holdId,
    orderId: facts.orderId,
    payload: {
      orderId: facts.orderId,
      holdId: facts.holdId,
      amountMinor: facts.totalMinor,
      currency: facts.currency,
      paymentDeadline: facts.paymentDeadline.toISOString(),
      contact: facts.contact,
    },
  });
}

function requestHash(holdId: string, contact: Contact): string {
  return createHash("sha256")
    .update(JSON.stringify([holdId, contact.email, contact.phone ?? null]))
    .digest("hex");
}

const PRISMA_TRANSACTION_START_TIMEOUT = "P2028";
const POOL_ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/** Pool-acquire (pg-pool) and transaction-start (Prisma) timeouts mean saturation, not a bug. */
function isSaturation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    ("code" in error && error.code === PRISMA_TRANSACTION_START_TIMEOUT) ||
    ("message" in error &&
      typeof error.message === "string" &&
      error.message.includes(POOL_ACQUIRE_TIMEOUT_MESSAGE))
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PG_UNIQUE_VIOLATION
  );
}

function toOrderView(order: {
  id: string;
  holdId: string;
  status: OrderStatus;
  totalMinor: number;
  currency: string;
  paymentDeadline: Date;
  correlationId: string;
  contactEmail: string;
  contactPhone: string | null;
  lines: OrderLineView[];
}): OrderView {
  return {
    id: order.id,
    holdId: order.holdId,
    status: order.status,
    totalMinor: order.totalMinor,
    currency: order.currency,
    paymentDeadline: order.paymentDeadline,
    correlationId: order.correlationId,
    contact: {
      email: order.contactEmail,
      ...(order.contactPhone === null ? {} : { phone: order.contactPhone }),
    },
    lines: order.lines.map(({ seatId, priceMinor, currency }) => ({
      seatId,
      priceMinor,
      currency,
    })),
  };
}

interface SeatState {
  readonly id: string;
  readonly status: string;
  readonly holdId: string | null;
}

interface Snapshot {
  /** Requested seats that are visibly not holdable. */
  readonly taken: string[];
  /** What the snapshot saw of each requested seat that belongs to the event. */
  readonly seen: ReadonlyMap<string, SeatState>;
}

/**
 * A refusal under the lock is a lost race only when a refused seat changed after the snapshot
 * read it, i.e. another buyer got there first. A refused seat the snapshot saw as it still is
 * (an expired but unswept hold, TD-013) or never saw (not in the event) lost no race.
 */
function lostRace(
  seen: ReadonlyMap<string, SeatState>,
  locked: readonly SeatState[],
  refused: readonly string[],
): boolean {
  const now = new Map(locked.map((seat) => [seat.id, seat]));
  return refused.some((id) => {
    const before = seen.get(id);
    const after = now.get(id);
    if (before === undefined) {
      return false;
    }
    return after === undefined || after.status !== before.status || after.holdId !== before.holdId;
  });
}

/**
 * Internal: thrown inside the locking transaction so it rolls back, carrying the counter the
 * refusal earned; holdOnce turns it into the public SeatUnavailableError outside.
 */
class LockedRefusal extends Error {
  constructor(
    readonly seatIds: readonly string[],
    readonly metric: BookingMetric,
  ) {
    super(`locked refusal: ${seatIds.join(", ")}`);
    this.name = "LockedRefusal";
  }
}

/** Internal: rolls the hold transaction back; holdOnce counts it and raises the public error. */
class LimitExceeded extends Error {
  constructor(
    readonly used: number,
    readonly requested: number,
  ) {
    super("limit exceeded");
    this.name = "LimitExceeded";
  }
}

export function createBookingService({
  db,
  clock,
  newId,
  logger = silentLogger,
  metrics,
}: BookingServiceDeps): BookingService {
  // Called only once the outcome is decided; fire-and-forget so a metrics outage can never
  // turn a booking into an error or add latency to it.
  function count(metric: BookingMetric, eventId: string): void {
    if (metrics === undefined) {
      return;
    }
    const failed = (error: unknown) =>
      logger.warn({ err: error, metric, eventId }, "metric failed");
    try {
      metrics.increment(metric, eventId).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  /** Lock-free read of the requested seats: which are visibly not holdable now. Advisory only. */
  async function snapshot(
    eventId: string,
    seatIds: readonly string[],
    at: Date,
  ): Promise<Snapshot> {
    const rows = await db.$queryRaw<(SeatState & { taken: boolean | null })[]>`
      SELECT s.id::text AS id, s.status::text AS status, s."holdId"::text AS "holdId",
             (s.status::text IN ('SOLD', 'IN_CHECKOUT')
              OR (s.status::text = 'HELD' AND h."holdExpiresAt" > ${at})) AS taken
      FROM seats s
      LEFT JOIN holds h ON h.id = s."holdId"
      WHERE s.id = ANY(${[...seatIds]}::uuid[]) AND s."eventId" = ${eventId}::uuid`;
    const taken = new Set(rows.filter((row) => row.taken === true).map((row) => row.id));
    return {
      taken: seatIds.filter((id) => taken.has(id)),
      seen: new Map(rows.map(({ id, status, holdId }) => [id, { id, status, holdId }])),
    };
  }

  async function findByIdempotencyKey(
    client: Pick<PrismaClient, "order">,
    buyer: Buyer,
    idempotencyKey: string,
    hash: string,
  ): Promise<OrderView | null> {
    const existing = await client.order.findUnique({
      where: { sessionId_idempotencyKey: { sessionId: buyer.sessionId, idempotencyKey } },
      include: orderInclude,
    });
    if (existing === null) {
      return null;
    }
    if (existing.requestHash !== hash) {
      throw new IdempotencyKeyReusedError(idempotencyKey);
    }
    return toOrderView(existing);
  }

  /**
   * First lock of every buyer-scoped transaction (holdSeats, placeOrder), before any seat row,
   * so the usage count cannot race a sibling request of the same buyer (ADR 0005).
   */
  async function lockBuyer(
    tx: Pick<PrismaClient, "$executeRaw">,
    eventId: string,
    buyerKey: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${buyerKey}`}, 0))`;
  }

  async function ownedHold(buyer: Buyer, holdId: string) {
    const owned = await db.hold.findUnique({
      where: { id: holdId },
      select: { eventId: true, buyerKey: true },
    });
    if (owned === null || owned.buyerKey !== buyer.buyerKey) {
      throw new HoldNotFoundError(holdId);
    }
    return owned;
  }

  async function holdOnce(buyer: Buyer, eventId: string, seatIds: readonly string[]) {
    if (seatIds.length === 0) {
      throw new InvalidSeatSelectionError("seatIds is empty");
    }
    if (seatIds.length > MAX_SEATS_PER_BUYER) {
      throw new InvalidSeatSelectionError(`at most ${MAX_SEATS_PER_BUYER} seats per hold`);
    }
    if (new Set(seatIds).size !== seatIds.length) {
      throw new InvalidSeatSelectionError("seatIds contains duplicates");
    }
    // Optimization only: the locked step below alone decides success (ADR 0005).
    const { taken, seen } = await snapshot(eventId, seatIds, clock.now());
    if (taken.length > 0) {
      count("seat_unavailable", eventId);
      throw new SeatUnavailableError(taken);
    }
    const hold = await db
      .$transaction(async (tx) => {
        await lockBuyer(tx, eventId, buyer.buyerKey);
        // Waiting (not NOWAIT) lock in id order: a loser sees the winner's committed state
        // instead of a spurious "taken" while the winner might still roll back (ADR 0005).
        const locked = await tx.$queryRaw<SeatState[]>`
          SELECT id::text AS id, status::text AS status, "holdId"::text AS "holdId"
          FROM seats
          WHERE id = ANY(${[...seatIds]}::uuid[]) AND "eventId" = ${eventId}::uuid
          ORDER BY id
          FOR UPDATE`;

        // Decision time is read only after the locks are held: it is the linearization point.
        const decidedAt = clock.now();

        const free = new Set(locked.filter((seat) => seat.status === "AVAILABLE").map((s) => s.id));
        const unavailable = seatIds.filter((id) => !free.has(id));
        if (unavailable.length > 0) {
          throw new LockedRefusal(
            unavailable,
            lostRace(seen, locked, unavailable) ? "race_lost" : "seat_unavailable",
          );
        }

        // Expired holds do not count: they are unswept but already released in effect (TD-013).
        const [usage] = await tx.$queryRaw<{ used: bigint }[]>`
          SELECT count(*) AS used
          FROM seats s
          LEFT JOIN holds h ON h.id = s."holdId"
          WHERE s."eventId" = ${eventId}::uuid AND s."claimBuyerKey" = ${buyer.buyerKey}
            AND (s.status::text IN ('IN_CHECKOUT', 'SOLD')
                 OR (s.status::text = 'HELD' AND h."holdExpiresAt" > ${decidedAt}))`;
        const used = Number(usage?.used ?? 0);
        if (used + seatIds.length > MAX_SEATS_PER_BUYER) {
          throw new LimitExceeded(used, seatIds.length);
        }

        const holdId = newId();
        const correlationId = newId();
        const holdExpiresAt = new Date(decidedAt.getTime() + HOLD_DURATION_MS);

        await tx.hold.create({
          data: {
            id: holdId,
            eventId,
            sessionId: buyer.sessionId,
            ...(buyer.userId === undefined ? {} : { userId: buyer.userId }),
            buyerKey: buyer.buyerKey,
            holdExpiresAt,
            correlationId,
          },
        });
        await tx.seat.updateMany({
          where: { id: { in: [...seatIds] } },
          data: { status: "HELD", holdId, claimBuyerKey: buyer.buyerKey },
        });

        // Same transaction as the state change: the event exists iff the hold committed.
        const envelope = heldEnvelope.parse({
          id: newId(),
          type: SEAT_HELD_EVENT,
          version: 1,
          occurredAt: decidedAt.toISOString(),
          correlationId,
          causationId: null,
          holdId,
          payload: { holdId, eventId, seatIds, holdExpiresAt: holdExpiresAt.toISOString() },
        });
        await tx.outboxEvent.create({
          data: {
            id: envelope.id,
            aggregateType: "hold",
            aggregateId: holdId,
            eventType: SEAT_HELD_EVENT,
            payload: envelope,
          },
        });

        return {
          id: holdId,
          eventId,
          seatIds: [...seatIds],
          status: "HELD" as const,
          holdExpiresAt,
          correlationId,
        };
      })
      .catch((error: unknown) => {
        if (error instanceof LimitExceeded) {
          count("limit_exceeded", eventId);
          throw new LimitExceededError(error.used, error.requested);
        }
        if (error instanceof LockedRefusal) {
          count(error.metric, eventId);
          throw new SeatUnavailableError(error.seatIds);
        }
        throw error;
      });
    // After commit, so a rolled-back hold never claims to have happened.
    count("hold_ok", eventId);
    logger
      .child(
        envelopeLogBindings({
          correlationId: hold.correlationId,
          causationId: null,
          holdId: hold.id,
        }),
      )
      .info({ eventId, seatIds: hold.seatIds }, "seats held");
    return hold;
  }

  return {
    async holdSeats(buyer, eventId, seatIds) {
      try {
        return await holdOnce(buyer, eventId, seatIds);
      } catch (error) {
        if (!isSaturation(error)) {
          throw error;
        }
        count("booking_busy", eventId);
        throw new BookingBusyError({ cause: error });
      }
    },

    async placeOrder(buyer, holdId, contact, idempotencyKey) {
      const hash = requestHash(holdId, contact);
      // A replay must win even after the hold expired, so it is checked before any hold logic.
      const replay = await findByIdempotencyKey(db, buyer, idempotencyKey, hash);
      if (replay !== null) {
        return replay;
      }

      try {
        // Unlocked read only to learn which buyer lock to take; the locked read below decides.
        const owned = await ownedHold(buyer, holdId);
        const placed = await db.$transaction(async (tx) => {
          // Lock order is buyer, hold, then seats by id, matching holdSeats (ADR 0005).
          await lockBuyer(tx, owned.eventId, buyer.buyerKey);
          const holds = await tx.$queryRaw<LockedHold[]>`
            SELECT "buyerKey", status::text AS status, "holdExpiresAt",
                   "correlationId"::text AS "correlationId", "eventId"::text AS "eventId"
            FROM holds WHERE id = ${holdId}::uuid FOR UPDATE`;
          const hold = holds[0];
          if (hold === undefined || hold.buyerKey !== buyer.buyerKey) {
            throw new HoldNotFoundError(holdId);
          }
          // A duplicate that waited on the hold lock now sees the winner's committed order.
          const duplicate = await findByIdempotencyKey(tx, buyer, idempotencyKey, hash);
          if (duplicate !== null) {
            return duplicate;
          }
          // Refused before the event is read: a settled hold needs no seat set.
          if (hold.status !== "HELD") {
            throw new HoldNotActiveError(holdId, hold.status);
          }
          // The seat set comes from the hold's own seat.held event, written in the hold's
          // transaction: querying seats by holdId would silently miss a seat that lost its hold.
          const held = await tx.outboxEvent.findFirst({
            where: { aggregateId: holdId, eventType: SEAT_HELD_EVENT },
          });
          if (held === null) {
            throw new HoldSeatSetMissingError(holdId);
          }
          const expectedSeatIds = heldEnvelope.parse(held.payload).payload.seatIds;
          const seats = await tx.$queryRaw<{ id: string; status: string; holdId: string | null }[]>`
            SELECT id::text AS id, status::text AS status, "holdId"::text AS "holdId"
            FROM seats WHERE id = ANY(${[...expectedSeatIds]}::uuid[]) ORDER BY id FOR UPDATE`;

          // Read only after the locks: this instant decides expiry and anchors the deadline.
          const placedAt = clock.now();

          assertPlaceable(holdId, hold, expectedSeatIds, seats, placedAt);

          const { priced, totalMinor, currency } = await priceSeats(tx, expectedSeatIds);

          const orderId = newId();
          const paymentDeadline = new Date(placedAt.getTime() + PAYMENT_WINDOW_MS);
          const created = await tx.order.create({
            data: {
              id: orderId,
              holdId,
              sessionId: buyer.sessionId,
              buyerKey: buyer.buyerKey,
              contactEmail: contact.email,
              contactPhone: contact.phone ?? null,
              totalMinor,
              currency,
              paymentDeadline,
              idempotencyKey,
              requestHash: hash,
              correlationId: hold.correlationId,
              createdAt: placedAt,
              lines: {
                create: priced.map((seat) => ({
                  id: newId(),
                  seatId: seat.id,
                  priceMinor: seat.priceMinor,
                  currency: seat.currency,
                })),
              },
            },
            include: orderInclude,
          });
          await tx.hold.update({ where: { id: holdId }, data: { status: "ORDERED" } });
          await tx.seat.updateMany({
            where: { id: { in: [...expectedSeatIds] }, status: "HELD" },
            data: { status: "IN_CHECKOUT" },
          });

          const envelope = orderPlacedEnvelope(newId(), {
            orderId,
            holdId,
            correlationId: hold.correlationId,
            placedAt,
            totalMinor,
            currency,
            paymentDeadline,
            contact,
          });
          await tx.outboxEvent.create({
            data: {
              id: envelope.id,
              aggregateType: "order",
              aggregateId: orderId,
              eventType: ORDER_PLACED_EVENT,
              payload: envelope,
            },
          });

          return { order: toOrderView(created), correlationId: hold.correlationId };
        });
        if ("order" in placed) {
          logger
            .child(
              envelopeLogBindings({
                correlationId: placed.correlationId,
                causationId: null,
                holdId,
                orderId: placed.order.id,
              }),
            )
            .info({ totalMinor: placed.order.totalMinor }, "order placed");
          return placed.order;
        }
        return placed;
      } catch (error) {
        // A concurrent duplicate lost the unique-constraint race: return the winner's order.
        if (isUniqueViolation(error)) {
          const winner = await findByIdempotencyKey(db, buyer, idempotencyKey, hash);
          if (winner !== null) {
            return winner;
          }
        }
        throw error;
      }
    },

    async getOrder(buyer, orderId) {
      const order = await db.order.findUnique({ where: { id: orderId }, include: orderInclude });
      if (order === null || order.buyerKey !== buyer.buyerKey) {
        return null;
      }
      return toOrderView(order);
    },

    async getHold(buyer, holdId) {
      const hold = await db.hold.findUnique({
        where: { id: holdId },
        include: { seats: { select: { id: true }, orderBy: { id: "asc" } } },
      });
      if (hold === null || hold.buyerKey !== buyer.buyerKey) {
        return null;
      }
      return {
        id: hold.id,
        eventId: hold.eventId,
        seatIds: hold.seats.map((seat) => seat.id),
        status: hold.status,
        holdExpiresAt: hold.holdExpiresAt,
        correlationId: hold.correlationId,
      };
    },
  };
}
