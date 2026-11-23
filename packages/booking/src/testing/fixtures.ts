import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@ticketarena/db";
import type { Buyer } from "../booking-service";

/** The instant every booking test seeds the catalog at and, unless it moves it, books at. */
export const NOW = new Date("2027-03-01T12:00:00.000Z");

/** A buyer keyed by `n`: the same `n` is the same buyer within a test file. */
export function buyer(n: number): Buyer {
  const key = n.toString(16).padStart(32, "0");
  return { sessionId: key, buyerKey: key };
}

/** A buyer no other test has seen: the buyer limit counts seats across a file's database. */
export function freshBuyer(): Buyer {
  const key = randomUUID().replaceAll("-", "");
  return { sessionId: key, buyerKey: key };
}

/** `count` free seats of an event (the demo event unless named), in id order. */
export async function freeSeats(
  db: PrismaClient,
  count: number,
  { eventId, order = "asc" }: { eventId?: string; order?: "asc" | "desc" } = {},
): Promise<{ eventId: string; seatIds: string[] }> {
  const event =
    eventId === undefined
      ? await db.event.findFirstOrThrow({ where: { demo: true } })
      : { id: eventId };
  const seats = await db.seat.findMany({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: order },
    take: count,
  });
  if (seats.length < count) {
    throw new Error(`freeSeats: the event has ${seats.length} free seats, ${count} wanted`);
  }
  return { eventId: event.id, seatIds: seats.map((seat) => seat.id) };
}

/** Records every metric a service counts, in order, with its event id. */
export function recordingMetrics<M extends string>({
  settles = true,
}: {
  /** `false` never settles an increment: proves the caller does not wait on metrics. */
  readonly settles?: boolean;
} = {}) {
  const counted: { metric: M; eventId: string }[] = [];
  return {
    counted,
    metrics: {
      increment: (metric: M, eventId: string): Promise<void> => {
        counted.push({ metric, eventId });
        return settles ? Promise.resolve() : new Promise<void>(() => undefined);
      },
    },
    /** The metric names counted so far, in order. */
    names: (): M[] => counted.map((entry) => entry.metric),
    /** The entries counted so far for one metric. */
    of: (metric: M) => counted.filter((entry) => entry.metric === metric),
    count: (metric: M): number => counted.filter((entry) => entry.metric === metric).length,
  };
}

/** The rejection of `call`; fails the test with the value if the call succeeded instead. */
export async function failureOf(call: Promise<unknown>): Promise<unknown> {
  let value: unknown;
  try {
    value = await call;
  } catch (error) {
    return error;
  }
  throw new Error("failureOf: the call succeeded where a failure was expected", { cause: value });
}

// Longer than the 50 ms the saturation tests once slept: a caller that does not wait for
// occupy's signal would run ahead of the occupier. A delay of the occupier only, never a way to
// order the test's own steps.
const SLOW_START_MS = 150;

/** An `occupy` `beforeStart` that delays the occupier, to prove callers await its signal. */
export function slowStart(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SLOW_START_MS));
}
