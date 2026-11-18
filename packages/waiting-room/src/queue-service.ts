import type { AdmissionPolicy, Clock, EventSchedule, JoinScore, QueueStore, Random } from "./ports";

export interface QueuedView {
  readonly status: "QUEUED";
  /** 1-based: position 1 is the head of the queue. */
  readonly position: number;
  /** `ceil(position / admitRatePerSecond)`. */
  readonly etaSeconds: number;
}

/** Outside the queue window the buyer may proceed at once (spec: "join admits immediately"). */
export type JoinResult = QueuedView | { readonly status: "ADMISSIBLE" };

export type StatusResult = QueuedView | { readonly status: "NOT_QUEUED" };

export interface QueueService {
  join(event: EventSchedule, sessionId: string): Promise<JoinResult>;
  status(eventId: string, sessionId: string): Promise<StatusResult>;
  leave(eventId: string, sessionId: string): Promise<{ readonly left: boolean }>;
}

export interface QueueServiceDeps {
  readonly store: QueueStore;
  readonly policy: AdmissionPolicy;
  readonly clock: Clock;
  readonly random: Random;
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
      if (!deps.policy.isQueueActive(event, now)) {
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
      const position = await deps.store.position(eventId, sessionId);
      return position === null ? { status: "NOT_QUEUED" } : queued(position);
    },

    async leave(eventId, sessionId) {
      return { left: await deps.store.leave(eventId, sessionId) };
    },
  };
}
