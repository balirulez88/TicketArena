import type { Logger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import type { AdmissionLimits, QueueService } from "@ticketarena/waiting-room";
import { createPeriodicLoop, type PeriodicLoop } from "./periodic-loop.js";

export interface AdmissionLoopsOptions {
  readonly queue: Pick<QueueService, "admitTick" | "reap">;
  readonly limits: AdmissionLimits;
  readonly prisma: PrismaClient;
  readonly admitIntervalMs: number;
  readonly reapIntervalMs: number;
  readonly logger: Logger;
}

/**
 * The admission ticker and the slot reaper (ADR 0008), each a pass over every event. Both are
 * atomic scripts against a shared bucket and active set, so several workers ticking at once still
 * never admit beyond `admitRate` or `maxActive`; time comes from the queue service's clock.
 */
export function createAdmissionLoops(options: AdmissionLoopsOptions): readonly PeriodicLoop[] {
  // Events are few and the catalog is seeded, so each pass simply reads all of them; an event
  // with an empty queue costs one script call and spends no tokens.
  const eachEvent = (action: (eventId: string) => Promise<unknown>) => async () => {
    const events = await options.prisma.event.findMany({ select: { id: true } });
    await Promise.all(events.map((event) => action(event.id)));
  };

  return [
    createPeriodicLoop({
      task: eachEvent((eventId) => options.queue.admitTick(eventId, options.limits)),
      intervalMs: options.admitIntervalMs,
      logger: options.logger,
      failureMessage: "admission tick failed; will retry",
    }),
    createPeriodicLoop({
      task: eachEvent((eventId) => options.queue.reap(eventId)),
      intervalMs: options.reapIntervalMs,
      logger: options.logger,
      failureMessage: "slot reaping failed; will retry",
    }),
  ];
}
