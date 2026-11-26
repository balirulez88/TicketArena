import type { Logger } from "@ticketarena/contracts";

/** How often a repeated identical failure is logged again while an outage lasts. */
export const FAILURE_LOG_WINDOW_MS = 60_000;

export interface FailureReporterOptions {
  readonly logger: Logger;
  readonly now: () => number;
  /** Logged at `error` with the cause. */
  readonly failureMessage: string;
  /** Logged at `info` on the first success after failures. */
  readonly recoveryMessage: string;
}

export interface FailureReporter {
  failed(error: unknown): void;
  succeeded(): void;
}

/**
 * Reports a background loop's failed iterations so an outage is visible without flooding the log:
 * the first failure, a failure with a different cause, and one line per window while the same
 * cause persists (with how many it stood for), then one line when the loop recovers.
 */
export function createFailureReporter(options: FailureReporterOptions): FailureReporter {
  let failures = 0;
  let firstFailureAt = 0;
  let lastLoggedAt = 0;
  let lastCause: string | undefined;
  let suppressed = 0;

  return {
    failed(error) {
      const at = options.now();
      const cause = causeOf(error);
      if (failures === 0) {
        firstFailureAt = at;
      }
      failures += 1;
      if (cause === lastCause && at - lastLoggedAt < FAILURE_LOG_WINDOW_MS) {
        suppressed += 1;
        return;
      }
      options.logger.error({ err: error, failures, suppressed }, options.failureMessage);
      lastCause = cause;
      lastLoggedAt = at;
      suppressed = 0;
    },
    succeeded() {
      if (failures === 0) {
        return;
      }
      options.logger.info(
        { failures, outageMs: options.now() - firstFailureAt },
        options.recoveryMessage,
      );
      failures = 0;
      lastCause = undefined;
      suppressed = 0;
    },
  };
}

function causeOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
