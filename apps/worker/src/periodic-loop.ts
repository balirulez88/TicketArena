import type { Logger } from "@ticketarena/contracts";

export interface PeriodicLoop {
  start(): void;
  /** Cancels the pending wait at once and lets an in-flight run finish. */
  stop(): Promise<void>;
}

export interface PeriodicLoopOptions {
  readonly task: () => Promise<void>;
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Logged with the error when a run fails; the loop always goes on. */
  readonly failureMessage: string;
}

/**
 * Runs `task` at start and then `intervalMs` after each run ends, so runs never overlap. A failed
 * run is logged and the next run retries; the wait is a cancellable timer so shutdown is prompt.
 */
export function createPeriodicLoop({
  task,
  intervalMs,
  logger,
  failureMessage,
}: PeriodicLoopOptions): PeriodicLoop {
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let running = false;

  async function runOnce(): Promise<void> {
    try {
      await task();
    } catch (error) {
      logger.warn({ err: error }, failureMessage);
    }
  }

  function run(): void {
    inFlight = runOnce().then(() => {
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
