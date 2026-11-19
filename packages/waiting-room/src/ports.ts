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
 * What a store join did: queued the member (or found it queued) at a 1-based `position`, or
 * found it holding a slot and left everything as it was (`ADMITTED`).
 */
export type JoinOutcome =
  | { readonly status: "QUEUED"; readonly position: number }
  | { readonly status: "ADMITTED" };

/**
 * Per-event queue storage. Every mutation is atomic, so concurrent joins never share a sequence
 * number and a re-join never moves a member (`ZADD NX`). Positions are 1-based.
 */
export interface QueueStore {
  /**
   * Answers `ADMITTED` without touching the queue, the slot or the `jti` when the member holds a
   * slot; otherwise adds the member unless already queued and returns its current position. The
   * slot check and the queue write are one atomic step.
   */
  join(eventId: string, member: string, score: JoinScore): Promise<JoinOutcome>;
  /** The member's position, or `null` when it is not queued. */
  position(eventId: string, member: string): Promise<number | null>;
  /**
   * Removes the member from the queue, frees its slot and revokes its admission `jti`, in one
   * atomic step; `true` when it was queued or held a slot.
   */
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
  /**
   * Deletes every key of the event in one atomic step, as if no one had ever joined: the demo
   * reset uses it. Every admission of the event is revoked with it.
   */
  clearEvent(eventId: string): Promise<void>;
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

/**
 * Where an event's waiting room stands: `NOT_OPEN` (nobody may join or be admitted yet), `ACTIVE`
 * (joins queue) or `CLOSED` (joins are admissible at once).
 */
export type QueuePhase = "NOT_OPEN" | "ACTIVE" | "CLOSED";

/** Decides an event's queue phase; load-based activation is phase 2. */
export interface AdmissionPolicy {
  phase(event: EventSchedule, now: Date): QueuePhase;
}
