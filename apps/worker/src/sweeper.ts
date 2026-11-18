import type { BookingService } from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";

export interface SweeperLoop {
  start(): void;
  /** Cancels the pending wait at once and lets an in-flight sweep finish. */
  stop(): Promise<void>;
}

export interface SweeperLoopOptions {
  readonly booking: Pick<BookingService, "sweepExpired">;
  readonly intervalMs: number;
  readonly logger: Logger;
}

/**
 * Runs a sweep at start and then `intervalMs` after each one ends, so sweeps never overlap.
 * The wait is a cancellable timer: the interval is long (15 s), and shutdown must not wait it out.
 */
export function createSweeperLoop({
  booking,
  intervalMs,
  logger,
}: SweeperLoopOptions): SweeperLoop {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let running = false;

  async function sweepOnce(): Promise<void> {
    try {
      await booking.sweepExpired();
    } catch (error) {
      // A database outage only delays expiry: lazy expiry in holdSeats still frees held seats,
      // and an overdue order is expired by the next sweep that gets through.
      logger.warn({ err: error }, "sweep failed; will retry");
    }
  }

  function run(): void {
    inFlight = sweepOnce().then(() => {
      if (running) {
        timer = setTimeout(run, intervalMs);
      }
    });
  }

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      run();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
