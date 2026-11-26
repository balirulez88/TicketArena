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
   * slot whose admission is still valid at `now`. A slot whose admission expired (the reaper has
   * not freed it yet) is freed and its `jti` revoked. Otherwise, or after that, adds the member
   * unless already queued and returns its current position. The check, the removal and the queue
   * write are one atomic step, so a delayed join never frees a slot granted after it was sent.
   */
  join(eventId: string, member: string, score: JoinScore, now: Date): Promise<JoinOutcome>;
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
   * One bounded reap step, atomic: examines at most `batchSize` candidates, first slots last seen
   * before `idleBefore` (oldest first), then `jti`s expired by `now` (earliest first). Each freed
   * slot has its `jti` revoked in the same step; an expired `jti` without a slot is dropped. The
   * reply names the freed members and whether candidates remain, so the caller repeats it.
   */
  reap(eventId: string, request: ReapRequest): Promise<ReapBatch>;
  /**
   * Gives the member a slot and the admission `jti` valid until `now + admissionTtlMs`, outside
   * the queue and the token bucket (the queue has closed: admission is immediate), and removes it
   * from the queue; one atomic step. A member that already holds a slot keeps it and its `jti`.
   * `true` when a slot was created.
   */
  admitImmediately(eventId: string, member: string, grant: ImmediateAdmission): Promise<boolean>;
  /**
   * The admission of the member's slot, or `null` when it holds none or its admission expired by
   * `now` (whether or not the reaper has freed the slot yet).
   */
  admission(eventId: string, member: string, now: Date): Promise<SlotAdmission | null>;
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

export interface ImmediateAdmission {
  readonly now: Date;
  readonly admissionTtlMs: number;
  readonly jti: string;
}

/** A held slot's admission: its `jti` and when it expires (`admittedAt + 30 min`). */
export interface SlotAdmission {
  readonly jti: string;
  readonly expiresAt: Date;
}

export interface Admission {
  readonly sessionId: string;
  readonly jti: string;
}

export interface ReapRequest {
  readonly now: Date;
  readonly idleBefore: Date;
  /** Most candidates (idle slots plus expired admissions) one call examines; a positive integer. */
  readonly batchSize: number;
}

export interface ReapBatch {
  readonly freed: readonly string[];
  /** `true` when idle slots or expired admissions are left for another call. */
  readonly more: boolean;
}

/** How much one reaper pass may do per event: at most `maxBatches` calls of `batchSize`. */
export interface ReapBudget {
  readonly batchSize: number;
  readonly maxBatches: number;
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
