import { envelopeSchema, seatHeldPayloadSchema } from "@ticketarena/contracts";
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

export interface BookingService {
  holdSeats(buyer: Buyer, eventId: string, seatIds: readonly string[]): Promise<HoldView>;
  /** `null` for an unknown hold and for someone else's: existence is not leaked. */
  getHold(buyer: Buyer, holdId: string): Promise<HoldView | null>;
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

interface LockedSeat {
  readonly id: string;
  readonly status: string;
}

export function createBookingService({ db, clock, newId }: BookingServiceDeps): BookingService {
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
