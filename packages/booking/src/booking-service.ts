import { createHash } from "node:crypto";
import {
  envelopeLogBindings,
  envelopeSchema,
  holdExpiredPayloadSchema,
  holdReleasedPayloadSchema,
  type Logger,
  orderExpiredPayloadSchema,
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
  /**
   * Gives a `HELD` hold back: `NOT_FOUND` unless the buyer owns it, `HOLD_NOT_ACTIVE` otherwise.
   * The returned view lists the seats this release freed. The buyer's waiting-room slot is not
   * touched: releasing a hold does not end shopping.
   */
  releaseHold(buyer: Buyer, holdId: string): Promise<HoldView>;
  /** `null` for an unknown order and for someone else's: existence is not leaked. */
  getOrder(buyer: Buyer, orderId: string): Promise<OrderView | null>;
  /**
   * The sweeper's step. Every `HELD` hold with `holdExpiresAt <= T` becomes `EXPIRED`, frees the
   * seats it still owns and writes `hold.expired`. Every `PENDING_PAYMENT` order with
   * `paymentDeadline + settlement grace <= T` becomes `EXPIRED`, frees its `IN_CHECKOUT` seats and
   * writes `order.expired`. Rows another transaction has locked are skipped, never waited for; the
   * next sweep finds them if they still match.
   */
  sweepExpired(): Promise<SweepResult>;
  /**
   * Returns the demo event to its seeded state so the demo can run again: deletes its holds,
   * orders, order lines and ledger rows and sets every seat back to `AVAILABLE`, in one
   * transaction. `NOT_DEMO_EVENT` for any other event; `RESET_BLOCKED` while a demo order is
   * `PENDING_PAYMENT` or a refund obligation is open, since either still owes a buyer an outcome.
   * Outbox events stay: they are history the relay may still be publishing.
   */
  resetEvent(eventId: string): Promise<ResetResult>;
}

export interface ResetResult {
  readonly eventId: string;
  readonly holdsDeleted: number;
  readonly ordersDeleted: number;
  readonly ledgerRowsDeleted: number;
  /** Seats that were not already plain `AVAILABLE`. */
  readonly seatsFreed: number;
}

export interface SweepResult {
  readonly expiredHoldIds: readonly string[];
  readonly expiredOrderIds: readonly string[];
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

/** The event's on-sale has not begun: no seat of it can be held yet (ADR 0008, defence in depth). */
export class NotOnSaleError extends Error {
  readonly code = "NOT_ON_SALE";

  constructor(
    readonly eventId: string,
    readonly onSaleAt: Date,
  ) {
    super(`NOT_ON_SALE: event ${eventId} goes on sale at ${onSaleAt.toISOString()}`);
    this.name = "NotOnSaleError";
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

/** Only the event flagged `demo` may be reset; nothing else is ever touched. */
export class NotDemoEventError extends Error {
  readonly code = "NOT_DEMO_EVENT";

  constructor(eventId: string) {
    super(`NOT_DEMO_EVENT: ${eventId} is not the demo event`);
    this.name = "NotDemoEventError";
  }
}

/** The demo event still has a booking whose outcome is owed; the reset changed nothing. */
export class ResetBlockedError extends Error {
  readonly code = "RESET_BLOCKED";

  constructor(reason: string) {
    super(`RESET_BLOCKED: ${reason}`);
    this.name = "ResetBlockedError";
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
const HOLD_RELEASED_EVENT = "hold.released";
const releasedEnvelope = envelopeSchema(holdReleasedPayloadSchema);
const HOLD_EXPIRED_EVENT = "hold.expired";
const expiredEnvelope = envelopeSchema(holdExpiredPayloadSchema);
const ORDER_EXPIRED_EVENT = "order.expired";
const orderExpiredEnvelope = envelopeSchema(orderExpiredPayloadSchema);
// Absorbs late delivery of an on-time payment and NTP-level clock skew (ADR 0006); best-effort.
const SETTLEMENT_GRACE_MS = 60_000;
// Bounds one sweep transaction; a sweep repeats batches until a short one says nothing is left.
const SWEEP_BATCH_SIZE = 100;

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

/** A hold is valid iff `T < holdExpiresAt`: the one rule every path applies to the same `T`. */
function isExpiredAt(holdExpiresAt: Date, decidedAt: Date): boolean {
  return decidedAt.getTime() >= holdExpiresAt.getTime();
}

/** A swept hold reads as expired to the buyer, whichever side's clock decided it. */
function assertHeld(holdId: string, status: string): void {
  if (status === "EXPIRED") {
    throw new HoldExpiredError(holdId);
  }
  if (status !== "HELD") {
    throw new HoldNotActiveError(holdId, status);
  }
}

function assertPlaceable(
  holdId: string,
  hold: LockedHold,
  expectedSeatIds: readonly string[],
  seats: readonly { id: string; status: string; holdId: string | null }[],
  placedAt: Date,
): void {
  assertHeld(holdId, hold.status);
  if (isExpiredAt(hold.holdExpiresAt, placedAt)) {
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

/**
 * Fingerprint of the canonical placeOrder request (ADR 0007): hold id, email and phone in a fixed
 * order, an absent phone encoded as null, so equal requests hash equally whatever their object
 * shape. A reused idempotency key is accepted only with the same fingerprint.
 */
export function requestHash(holdId: string, contact: Contact): string {
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
 * Lazy expiry (ADR 0005): a seat is free iff `AVAILABLE`, or `HELD` by a hold that is expired at
 * `T`. `IN_CHECKOUT` and `SOLD` are never free. The seats are locked, the holds are not: the
 * expiries are read by a fresh statement so a hold committed during the lock wait is visible
 * (READ COMMITTED), and leaving hold rows unlocked keeps the global lock order (hold before seat).
 * An expiry never moves, so reading it unlocked cannot change the decision.
 */
async function freeSeats(
  tx: Pick<PrismaClient, "$queryRaw">,
  locked: readonly SeatState[],
  decidedAt: Date,
): Promise<Set<string>> {
  const holdIds = [
    ...new Set(
      locked.flatMap((seat) =>
        seat.status === "HELD" && seat.holdId !== null ? [seat.holdId] : [],
      ),
    ),
  ];
  const holds =
    holdIds.length === 0
      ? []
      : await tx.$queryRaw<{ id: string; holdExpiresAt: Date }[]>`
          SELECT id::text AS id, "holdExpiresAt" FROM holds WHERE id = ANY(${holdIds}::uuid[])`;
  const expired = new Set(
    holds.filter((hold) => isExpiredAt(hold.holdExpiresAt, decidedAt)).map((hold) => hold.id),
  );
  return new Set(
    locked
      .filter(
        (seat) =>
          seat.status === "AVAILABLE" ||
          (seat.status === "HELD" && seat.holdId !== null && expired.has(seat.holdId)),
      )
      .map((seat) => seat.id),
  );
}

/**
 * A refusal under the lock is a lost race only when a refused seat changed after the snapshot
 * read it, i.e. another buyer got there first. A refused seat the snapshot saw as it still is
 * or never saw (not in the event) lost no race.
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

  /** One transaction, one `T`: expires up to a batch of holds and reports the ids it expired. */
  async function sweepBatch(): Promise<{ id: string; correlationId: string; seatIds: string[] }[]> {
    const swept = await db.$transaction(async (tx) => {
      // T is read before the claim because the claim filters by it. SKIP LOCKED never waits, so
      // T is not stale by a hold lock wait; and since an expiry never moves, a hold expired at T
      // stays expired. Under READ COMMITTED a hold placeOrder converted and committed no longer
      // matches `status = 'HELD'`; one it still has locked is skipped (spec: Expiry).
      const sweptAt = clock.now();
      const holds = await tx.$queryRaw<{ id: string; correlationId: string }[]>`
        SELECT id::text AS id, "correlationId"::text AS "correlationId"
        FROM holds
        WHERE status::text = 'HELD' AND "holdExpiresAt" <= ${sweptAt}
        ORDER BY id
        LIMIT ${SWEEP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (holds.length === 0) {
        return [];
      }
      const holdIds = holds.map((hold) => hold.id);
      // Lock order: holds, then seats by id (ADR 0005). Only seats these holds still own: a seat
      // taken over lazily belongs to its new hold and must stay as it is.
      const seats = await tx.$queryRaw<{ id: string; holdId: string }[]>`
        SELECT id::text AS id, "holdId"::text AS "holdId" FROM seats
        WHERE "holdId" = ANY(${holdIds}::uuid[]) AND status::text = 'HELD'
        ORDER BY id FOR UPDATE`;

      await tx.hold.updateMany({ where: { id: { in: holdIds } }, data: { status: "EXPIRED" } });
      await tx.seat.updateMany({
        where: { id: { in: seats.map((seat) => seat.id) }, holdId: { in: holdIds } },
        data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
      });

      const expired = holds.map((hold) => ({
        ...hold,
        seatIds: seats.filter((seat) => seat.holdId === hold.id).map((seat) => seat.id),
      }));
      // Same transaction as the state change: each event exists iff its expiry committed.
      await tx.outboxEvent.createMany({
        data: expired.map(({ id: holdId, correlationId, seatIds }) => {
          const envelope = expiredEnvelope.parse({
            id: newId(),
            type: HOLD_EXPIRED_EVENT,
            version: 1,
            occurredAt: sweptAt.toISOString(),
            correlationId,
            causationId: null,
            holdId,
            payload: { holdId, seatIds },
          });
          return {
            id: envelope.id,
            aggregateType: "hold",
            aggregateId: holdId,
            eventType: HOLD_EXPIRED_EVENT,
            payload: envelope,
          };
        }),
      });
      return expired;
    });
    for (const hold of swept) {
      logger
        .child(
          envelopeLogBindings({
            correlationId: hold.correlationId,
            causationId: null,
            holdId: hold.id,
          }),
        )
        .info({ seatIds: hold.seatIds }, "hold expired");
    }
    return swept;
  }

  interface ExpiredOrder {
    readonly id: string;
    readonly holdId: string;
    readonly correlationId: string;
    readonly seatIds: string[];
  }

  /**
   * One transaction, one `T`: expires up to a batch of overdue orders. This is the only path that
   * frees `IN_CHECKOUT` seats of an unpaid order, and it does so in the transaction that ends the
   * checkout, so a seat is never `AVAILABLE` while its order is still `PENDING_PAYMENT`.
   */
  async function sweepOrderBatch(): Promise<ExpiredOrder[]> {
    const swept = await db.$transaction(async (tx) => {
      // As for holds: SKIP LOCKED never waits, so T read before the claim is not stale. An order
      // the saga holds locked is skipped; once the saga commits it no longer matches the status.
      const sweptAt = clock.now();
      const overdueBefore = new Date(sweptAt.getTime() - SETTLEMENT_GRACE_MS);
      const orders = await tx.$queryRaw<
        {
          id: string;
          holdId: string;
          correlationId: string;
          contactEmail: string;
          contactPhone: string | null;
        }[]
      >`
        SELECT id::text AS id, "holdId"::text AS "holdId",
               "correlationId"::text AS "correlationId", "contactEmail", "contactPhone"
        FROM orders
        WHERE status::text = 'PENDING_PAYMENT' AND "paymentDeadline" <= ${overdueBefore}
        ORDER BY id
        LIMIT ${SWEEP_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED`;
      if (orders.length === 0) {
        return [];
      }
      const holdIds = orders.map((order) => order.holdId);
      // Lock order: orders, then seats by id, as the payment saga does. A seat in checkout keeps
      // its order's holdId, so the holdId names exactly the seats this checkout claims.
      const seats = await tx.$queryRaw<{ id: string; holdId: string }[]>`
        SELECT id::text AS id, "holdId"::text AS "holdId" FROM seats
        WHERE "holdId" = ANY(${holdIds}::uuid[]) AND status::text = 'IN_CHECKOUT'
        ORDER BY id FOR UPDATE`;

      await tx.order.updateMany({
        where: { id: { in: orders.map((order) => order.id) } },
        data: { status: "EXPIRED" },
      });
      await tx.seat.updateMany({
        where: { id: { in: seats.map((seat) => seat.id) }, status: "IN_CHECKOUT" },
        data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
      });

      // Same transaction as the state change: each event exists iff its expiry committed.
      await tx.outboxEvent.createMany({
        data: orders.map((order) => {
          const envelope = orderExpiredEnvelope.parse({
            id: newId(),
            type: ORDER_EXPIRED_EVENT,
            version: 1,
            occurredAt: sweptAt.toISOString(),
            correlationId: order.correlationId,
            causationId: null,
            holdId: order.holdId,
            orderId: order.id,
            payload: {
              orderId: order.id,
              contact: {
                email: order.contactEmail,
                ...(order.contactPhone === null ? {} : { phone: order.contactPhone }),
              },
            },
          });
          return {
            id: envelope.id,
            aggregateType: "order",
            aggregateId: order.id,
            eventType: ORDER_EXPIRED_EVENT,
            payload: envelope,
          };
        }),
      });
      return orders.map(({ id, holdId, correlationId }) => ({
        id,
        holdId,
        correlationId,
        seatIds: seats.filter((seat) => seat.holdId === holdId).map((seat) => seat.id),
      }));
    });
    for (const order of swept) {
      logger
        .child(
          envelopeLogBindings({
            correlationId: order.correlationId,
            causationId: null,
            holdId: order.holdId,
            orderId: order.id,
          }),
        )
        .info({ seatIds: order.seatIds }, "order expired");
    }
    return swept;
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
    // Defence in depth behind the waiting room: whatever admission a buyer holds, no seat is held
    // before the on-sale, so arriving early can never beat the randomized pre-queue (ADR 0008).
    // An unknown event passes here and is refused below: none of its seats exist.
    const event = await db.event.findUnique({ where: { id: eventId }, select: { onSaleAt: true } });
    if (event !== null && clock.now().getTime() < event.onSaleAt.getTime()) {
      throw new NotOnSaleError(eventId, event.onSaleAt);
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

        const free = await freeSeats(tx, locked, decidedAt);
        const unavailable = seatIds.filter((id) => !free.has(id));
        if (unavailable.length > 0) {
          throw new LockedRefusal(
            unavailable,
            lostRace(seen, locked, unavailable) ? "race_lost" : "seat_unavailable",
          );
        }

        // Expired holds do not count: they are unswept but already released in effect.
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
            return { kind: "replayed", order: duplicate } as const;
          }
          // Refused before the event is read: a settled hold needs no seat set.
          assertHeld(holdId, hold.status);
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

          return {
            kind: "created",
            order: toOrderView(created),
            correlationId: hold.correlationId,
          } as const;
        });
        // Only a request that wrote the order may claim it was placed; a replay stays silent.
        if (placed.kind === "created") {
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
        }
        return placed.order;
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

    async releaseHold(buyer, holdId) {
      // Unlocked read only to learn which buyer lock to take; the locked read below decides.
      const owned = await ownedHold(buyer, holdId);
      const released = await db.$transaction(async (tx) => {
        // Global lock order: buyer, hold, then seats by id, matching holdSeats (ADR 0005).
        await lockBuyer(tx, owned.eventId, buyer.buyerKey);
        const holds = await tx.$queryRaw<LockedHold[]>`
          SELECT "buyerKey", status::text AS status, "holdExpiresAt",
                 "correlationId"::text AS "correlationId", "eventId"::text AS "eventId"
          FROM holds WHERE id = ${holdId}::uuid FOR UPDATE`;
        const hold = holds[0];
        if (hold === undefined || hold.buyerKey !== buyer.buyerKey) {
          throw new HoldNotFoundError(holdId);
        }
        if (hold.status !== "HELD") {
          throw new HoldNotActiveError(holdId, hold.status);
        }
        // Only seats still carrying this holdId: a seat taken over by another hold is not ours
        // to free. The hold row lock serializes this with placeOrder on the same hold.
        const seats = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM seats
          WHERE "holdId" = ${holdId}::uuid AND status::text = 'HELD'
          ORDER BY id FOR UPDATE`;
        const seatIds = seats.map((seat) => seat.id);
        const releasedAt = clock.now();

        await tx.hold.update({ where: { id: holdId }, data: { status: "RELEASED" } });
        await tx.seat.updateMany({
          where: { id: { in: seatIds }, holdId },
          data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
        });

        // Same transaction as the state change: the event exists iff the release committed.
        const envelope = releasedEnvelope.parse({
          id: newId(),
          type: HOLD_RELEASED_EVENT,
          version: 1,
          occurredAt: releasedAt.toISOString(),
          correlationId: hold.correlationId,
          causationId: null,
          holdId,
          payload: { holdId, seatIds },
        });
        await tx.outboxEvent.create({
          data: {
            id: envelope.id,
            aggregateType: "hold",
            aggregateId: holdId,
            eventType: HOLD_RELEASED_EVENT,
            payload: envelope,
          },
        });

        return {
          id: holdId,
          eventId: hold.eventId,
          seatIds,
          status: "RELEASED" as const,
          holdExpiresAt: hold.holdExpiresAt,
          correlationId: hold.correlationId,
        };
      });
      logger
        .child(
          envelopeLogBindings({ correlationId: released.correlationId, causationId: null, holdId }),
        )
        .info({ seatIds: released.seatIds }, "hold released");
      return released;
    },

    async sweepExpired() {
      const expiredHoldIds: string[] = [];
      for (;;) {
        const batch = await sweepBatch();
        expiredHoldIds.push(...batch.map((hold) => hold.id));
        if (batch.length < SWEEP_BATCH_SIZE) {
          break;
        }
      }
      const expiredOrderIds: string[] = [];
      for (;;) {
        const batch = await sweepOrderBatch();
        expiredOrderIds.push(...batch.map((order) => order.id));
        if (batch.length < SWEEP_BATCH_SIZE) {
          return { expiredHoldIds, expiredOrderIds };
        }
      }
    },

    async resetEvent(eventId) {
      const result = await db.$transaction(async (tx) => {
        const events = await tx.$queryRaw<{ demo: boolean }[]>`
          SELECT demo FROM events WHERE id = ${eventId}::uuid`;
        if (events[0]?.demo !== true) {
          throw new NotDemoEventError(eventId);
        }
        // Lock order holds, orders, seats: placeOrder locks a hold before its seats and the saga
        // an order before its seats, so none of them can hold what this waits for while waiting
        // for what this holds (ADR 0005). A placeOrder that committed while this waited on its
        // hold is seen by the fresh orders read below (READ COMMITTED).
        const holds = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM holds
          WHERE "eventId" = ${eventId}::uuid ORDER BY id FOR UPDATE`;
        const holdIds = holds.map((hold) => hold.id);
        const orders = await tx.$queryRaw<{ id: string; status: string }[]>`
          SELECT id::text AS id, status::text AS status FROM orders
          WHERE "holdId" = ANY(${holdIds}::uuid[]) ORDER BY id FOR UPDATE`;
        const pending = orders.filter((order) => order.status === "PENDING_PAYMENT").length;
        if (pending > 0) {
          throw new ResetBlockedError(`${pending} demo order(s) are PENDING_PAYMENT`);
        }
        const orderIds = orders.map((order) => order.id);
        // MANUAL_REVIEW is an obligation escalated to a human: the money is still not returned.
        const [obligations] = await tx.$queryRaw<{ open: bigint }[]>`
          SELECT count(*) AS open FROM order_payments
          WHERE "orderId" = ANY(${orderIds}::uuid[])
            AND disposition::text IN ('REFUND_REQUESTED', 'MANUAL_REVIEW')`;
        const open = Number(obligations?.open ?? 0);
        if (open > 0) {
          throw new ResetBlockedError(`${open} demo refund obligation(s) are open`);
        }
        const seats = await tx.$queryRaw<
          { id: string; status: string; holdId: string | null; claimBuyerKey: string | null }[]
        >`
          SELECT id::text AS id, status::text AS status, "holdId"::text AS "holdId", "claimBuyerKey"
          FROM seats WHERE "eventId" = ${eventId}::uuid ORDER BY id FOR UPDATE`;
        // With every seat locked no booking can change seat state any more, but one that
        // committed a new hold after the holds were locked would be wiped unaccounted for (and
        // could carry an order this check never saw), so the reset gives up instead.
        const known = new Set(holdIds);
        if (seats.some((seat) => seat.holdId !== null && !known.has(seat.holdId))) {
          throw new ResetBlockedError("a demo booking changed during the reset; retry");
        }
        const dirty = seats
          .filter(
            (seat) =>
              seat.status !== "AVAILABLE" || seat.holdId !== null || seat.claimBuyerKey !== null,
          )
          .map((seat) => seat.id);

        // Children before parents: seats and ledger rows reference holds and orders.
        await tx.seat.updateMany({
          where: { id: { in: dirty } },
          data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
        });
        const ledger = await tx.orderPayment.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
        await tx.order.deleteMany({ where: { id: { in: orderIds } } });
        await tx.hold.deleteMany({ where: { id: { in: holdIds } } });
        return {
          eventId,
          holdsDeleted: holdIds.length,
          ordersDeleted: orderIds.length,
          ledgerRowsDeleted: ledger.count,
          seatsFreed: dirty.length,
        };
      });
      logger.info({ ...result }, "demo event reset");
      return result;
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
