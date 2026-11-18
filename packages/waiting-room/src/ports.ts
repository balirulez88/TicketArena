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
  /**
   * Moves members from the queue head into the active set while the event's token bucket and
   * `maxActive` allow (see `AdmitRequest`), in one atomic step, and returns them in queue order.
   */
  admit(eventId: string, request: AdmitRequest): Promise<readonly Admission[]>;
  /** Sets the member's `lastSeenAt` to `now` if it holds a slot; `true` when it does. */
  heartbeat(eventId: string, member: string, now: Date): Promise<boolean>;
  /** Frees the member's slot and revokes its admission `jti`; `true` when it held a slot. */
  releaseSlot(eventId: string, member: string): Promise<boolean>;
  /**
   * Frees every slot last seen before `idleBefore` or whose admission expired by `now`, revoking
   * their `jti`s, and drops expired `jti`s; returns the freed members.
   */
  reap(eventId: string, cutoffs: ReapCutoffs): Promise<readonly string[]>;
  /** `true` while the `jti` is in the event's admitted set and has not expired by `now`. */
  isAdmitted(eventId: string, jti: string, now: Date): Promise<boolean>;
  /** Queue length and active-slot count, read in one atomic step. */
  counts(eventId: string): Promise<QueueCounts>;
}

/**
 * One admission tick. The bucket holds at most `admitRate` tokens (the burst) and refills at
 * `admitRate` per second of `now`; each admission spends one token and takes one of `maxActive`
 * slots. `jtis` supplies the admission ids, one per admitted member, so it caps the tick too.
 */
export interface AdmitRequest {
  readonly now: Date;
  readonly admitRate: number;
  readonly maxActive: number;
  /** How long an admission stays valid from `now` (its `jti` expiry). */
  readonly admissionTtlMs: number;
  readonly jtis: readonly string[];
}

export interface Admission {
  readonly sessionId: string;
  readonly jti: string;
}

export interface ReapCutoffs {
  readonly now: Date;
  readonly idleBefore: Date;
}

export interface QueueCounts {
  readonly queued: number;
  readonly active: number;
}

/** Per-event admission limits; the worker's ticker supplies them (ADR 0008). */
export interface AdmissionLimits {
  /** Admissions per second and the bucket's burst; a positive integer. */
  readonly admitRate: number;
  /** Cap on concurrently active shoppers. */
  readonly maxActive: number;
}

/** Decides whether an event's waiting room is in force; load-based activation is phase 2. */
export interface AdmissionPolicy {
  isQueueActive(event: EventSchedule, now: Date): boolean;
}
