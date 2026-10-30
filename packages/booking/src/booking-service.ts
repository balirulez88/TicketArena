import { createHash } from "node:crypto";
import {
  envelopeSchema,
  orderPlacedPayloadSchema,
  seatHeldPayloadSchema,
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

export interface OrderView {
  readonly id: string;
  readonly holdId: string;
  readonly status: OrderStatus;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentDeadline: Date;
  readonly correlationId: string;
  readonly contact: Contact;
  readonly lines: { seatId: string; priceMinor: number; currency: string }[];
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
  lines: { seatId: string; priceMinor: number; currency: string }[];
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

interface LockedSeat {
  readonly id: string;
  readonly status: string;
}

export function createBookingService({ db, clock, newId }: BookingServiceDeps): BookingService {
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

  return {
    async holdSeats(buyer, eventId, seatIds) {
      return db.$transaction(async (tx) => {
        // Waiting (not NOWAIT) lock in id order: a loser sees the winner's committed state
        // instead of a spurious "taken" while the winner might still roll back (ADR 0005).
        const locked = await tx.$queryRaw<LockedSeat[]>`
          SELECT id::text AS id, status::text AS status
          FROM seats
          WHERE id = ANY(${[...seatIds]}::uuid[]) AND "eventId" = ${eventId}::uuid
          ORDER BY id
          FOR UPDATE`;

        // Decision time is read only after the locks are held: it is the linearization point.
        const decidedAt = clock.now();

        const free = new Set(locked.filter((seat) => seat.status === "AVAILABLE").map((s) => s.id));
        const unavailable = seatIds.filter((id) => !free.has(id));
        if (unavailable.length > 0) {
          throw new SeatUnavailableError(unavailable);
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
      });
    },

    async placeOrder(buyer, holdId, contact, idempotencyKey) {
      const hash = requestHash(holdId, contact);
      // A replay must win even after the hold expired, so it is checked before any hold logic.
      const replay = await findByIdempotencyKey(db, buyer, idempotencyKey, hash);
      if (replay !== null) {
        return replay;
      }

      try {
        return await db.$transaction(async (tx) => {
          // Lock order is hold, then seats by id, matching holdSeats (ADR 0005).
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
          // The seat set comes from the hold's own seat.held event, written in the hold's
          // transaction: querying seats by holdId would silently miss a seat that lost its hold.
          const held = await tx.outboxEvent.findFirst({
            where: { aggregateId: holdId, eventType: SEAT_HELD_EVENT },
          });
          const expectedSeatIds = heldEnvelope.parse(held?.payload).payload.seatIds;
          const seats = await tx.$queryRaw<{ id: string; status: string; holdId: string | null }[]>`
            SELECT id::text AS id, status::text AS status, "holdId"::text AS "holdId"
            FROM seats WHERE id = ANY(${[...expectedSeatIds]}::uuid[]) ORDER BY id FOR UPDATE`;

          // Read only after the locks: this instant decides expiry and anchors the deadline.
          const placedAt = clock.now();

          assertPlaceable(holdId, hold, expectedSeatIds, seats, placedAt);

          const priced = await tx.$queryRaw<PricedSeat[]>`
            SELECT s.id::text AS id, sec."priceMinor", sec.currency
            FROM seats s
            JOIN rows r ON r.id = s."rowId"
            JOIN sections sec ON sec.id = r."sectionId"
            WHERE s."holdId" = ${holdId}::uuid
            ORDER BY s.id`;
          const totalMinor = priced.reduce((sum, seat) => sum + seat.priceMinor, 0);
          // assertPlaceable guarantees at least one seat; the fallback only satisfies the type.
          const currency = priced[0]?.currency ?? "EUR";

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
          await tx.seat.updateMany({ where: { holdId }, data: { status: "IN_CHECKOUT" } });

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

          return toOrderView(created);
        });
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
