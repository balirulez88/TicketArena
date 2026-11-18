/** Injected time source; the waiting room never reads the system clock itself. */
export interface Clock {
  now(): Date;
}

/** Injected randomness; `next()` returns a value in `[0, 1)`, like `Math.random`. */
export interface Random {
  next(): number;
}

/** The part of an Event the waiting room needs: its id and its schedule. */
export interface EventSchedule {
  readonly id: string;
  readonly onSaleAt: Date;
  readonly queueOpensAt: Date;
  readonly queueClosesAt: Date;
}

/**
 * How a new member is scored. A pre-queue join carries its random score in `[0, 1)`; a later join
 * is scored `1 + sequence` by the store, so every pre-queue member sorts ahead of every later one.
 */
export type JoinScore =
  | { readonly kind: "PRE_QUEUE"; readonly score: number }
  | { readonly kind: "SEQUENCE" };

/**
 * Per-event queue storage. Every mutation is atomic, so concurrent joins never share a sequence
 * number and a re-join never moves a member (`ZADD NX`). Positions are 1-based.
 */
export interface QueueStore {
  /** Adds the member unless already queued and returns its current position. */
  join(eventId: string, member: string, score: JoinScore): Promise<number>;
  /** The member's position, or `null` when it is not queued. */
  position(eventId: string, member: string): Promise<number | null>;
  /** Removes the member; `true` when it was queued. */
  leave(eventId: string, member: string): Promise<boolean>;
}

/** Decides whether an event's waiting room is in force; load-based activation is phase 2. */
export interface AdmissionPolicy {
  isQueueActive(event: EventSchedule, now: Date): boolean;
}
