import type {
  Admission,
  AdmissionLimits,
  AdmissionPolicy,
  Clock,
  EventSchedule,
  JoinScore,
  QueueCounts,
  QueueStore,
  Random,
} from "./ports";

/** A slot not seen (no status poll, no admitted call) for longer than this is reaped (spec). */
export const SLOT_IDLE_TIMEOUT_MS = 90_000;

/** An admission is valid this long from `admittedAt`, fixed, never renewed (ADR 0008). */
export const ADMISSION_TTL_MS = 30 * 60_000;

export interface QueuedView {
  readonly status: "QUEUED";
  /** 1-based: position 1 is the head of the queue. */
  readonly position: number;
  /** `ceil(position / admitRatePerSecond)`. */
  readonly etaSeconds: number;
}

/**
 * `NOT_OPEN` before the queue opens (nothing queued, no one admitted); `ADMISSIBLE` once the queue
 * has closed: the buyer may proceed at once (spec: "join admits immediately").
 */
export type JoinResult =
  | QueuedView
  | { readonly status: "NOT_OPEN"; readonly queueOpensAt: Date }
  | { readonly status: "ADMISSIBLE" };

/** `ADMITTED`: the session holds one of the event's active slots. */
export type StatusResult =
  | QueuedView
  | { readonly status: "ADMITTED" }
  | { readonly status: "NOT_QUEUED" };

export interface QueueService {
  join(event: EventSchedule, sessionId: string): Promise<JoinResult>;
  /** Also heartbeats the session's slot when it holds one. */
  status(eventId: string, sessionId: string): Promise<StatusResult>;
  /** Leaves the queue and frees the session's slot, revoking its admission. */
  leave(eventId: string, sessionId: string): Promise<{ readonly left: boolean }>;
  /** Refreshes the slot's `lastSeenAt`; `true` when the session holds a slot. */
  heartbeat(eventId: string, sessionId: string): Promise<boolean>;
  /**
   * One admission tick (the worker runs it every second): admits while the limits allow, and no
   * one before the event's `onSaleAt`.
   */
  admitTick(event: EventSchedule, limits: AdmissionLimits): Promise<readonly Admission[]>;
  /** Frees slots idle for over 90 s or with an expired admission; returns the freed sessions. */
  reap(eventId: string): Promise<readonly string[]>;
  /** Frees the session's slot and revokes its admission (order placed); `true` when it held one. */
  releaseSlot(eventId: string, sessionId: string): Promise<boolean>;
  /** Whether the admission `jti` is valid now: in the admitted set and not expired. */
  isAdmitted(eventId: string, jti: string): Promise<boolean>;
  /** Queue length and active-shopper count, for the dashboard. */
  counts(eventId: string): Promise<QueueCounts>;
}

export interface QueueServiceDeps {
  readonly store: QueueStore;
  readonly policy: AdmissionPolicy;
  readonly clock: Clock;
  readonly random: Random;
  /** Admission ids (`jti`); injected like the clock so ids are not drawn inside the module. */
  readonly newId: () => string;
  /** Expected admissions per second; used only for the ETA. */
  readonly admitRatePerSecond: number;
}

export function createQueueService(deps: QueueServiceDeps): QueueService {
  const queued = (position: number): QueuedView => ({
    status: "QUEUED",
    position,
    etaSeconds: Math.ceil(position / deps.admitRatePerSecond),
  });

  return {
    async join(event, sessionId) {
      const now = deps.clock.now();
      const phase = deps.policy.phase(event, now);
      // Admitting before the queue opens would hand an early arrival an admission still valid at
      // onSaleAt, skipping the randomized pre-queue (ADR 0008); so it only says when to come back.
      if (phase === "NOT_OPEN") {
        return { status: "NOT_OPEN", queueOpensAt: event.queueOpensAt };
      }
      if (phase === "CLOSED") {
        return { status: "ADMISSIBLE" };
      }
      // A random score below every later score is equivalent to shuffling the whole pre-queue at
      // onSaleAt (ADR 0008), so arriving early or refreshing gains nothing.
      const score: JoinScore =
        now.getTime() < event.onSaleAt.getTime()
          ? { kind: "PRE_QUEUE", score: deps.random.next() }
          : { kind: "SEQUENCE" };
      return queued(await deps.store.join(event.id, sessionId, score));
    },

    async status(eventId, sessionId) {
      if (await deps.store.heartbeat(eventId, sessionId, deps.clock.now())) {
        return { status: "ADMITTED" };
      }
      const position = await deps.store.position(eventId, sessionId);
      return position === null ? { status: "NOT_QUEUED" } : queued(position);
    },

    async leave(eventId, sessionId) {
      return { left: await deps.store.leave(eventId, sessionId) };
    },

    heartbeat(eventId, sessionId) {
      return deps.store.heartbeat(eventId, sessionId, deps.clock.now());
    },

    async admitTick(event, limits) {
      const now = deps.clock.now();
      // The pre-queue is ordered at random so arriving early gains nothing (ADR 0008); admitting
      // before onSaleAt would serve it first come, first served, so nobody is admitted until then.
      if (now.getTime() < event.onSaleAt.getTime()) {
        return [];
      }
      // A tick admits at most the burst, so one fresh id per possible admission is enough.
      return deps.store.admit(event.id, {
        now,
        admitRate: limits.admitRate,
        maxActive: limits.maxActive,
        admissionTtlMs: ADMISSION_TTL_MS,
        jtis: Array.from({ length: Math.ceil(limits.admitRate) }, () => deps.newId()),
      });
    },

    reap(eventId) {
      const now = deps.clock.now();
      return deps.store.reap(eventId, {
        now,
        idleBefore: new Date(now.getTime() - SLOT_IDLE_TIMEOUT_MS),
      });
    },

    releaseSlot(eventId, sessionId) {
      return deps.store.releaseSlot(eventId, sessionId);
    },

    isAdmitted(eventId, jti) {
      return deps.store.isAdmitted(eventId, jti, deps.clock.now());
    },

    counts(eventId) {
      return deps.store.counts(eventId);
    },
  };
}
