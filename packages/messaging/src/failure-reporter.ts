import type { Logger } from "@ticketarena/contracts";

/** How often a repeated failure with the same cause is logged again while an outage lasts. */
export const FAILURE_LOG_WINDOW_MS = 60_000;

/**
 * How many distinct causes keep their own window during one outage. Causes can carry ids or
 * addresses, so an unbounded map would grow with every new message text; past the bound the
 * least recently logged cause is forgotten and, at worst, logged once more than the window allows.
 */
export const MAX_TRACKED_FAILURE_CAUSES = 32;

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

interface CauseWindow {
  readonly loggedAt: number;
  suppressed: number;
}

/**
 * Reports a background loop's failed iterations so an outage is visible without flooding the log:
 * the first failure of each cause, then at most one line per window per cause while it persists
 * (with how many it stood for), even when causes alternate, then one line when the loop recovers.
 */
export function createFailureReporter(options: FailureReporterOptions): FailureReporter {
  let failures = 0;
  let firstFailureAt = 0;
  // Insertion order is log order: the first key is always the least recently logged cause.
  const windows = new Map<string, CauseWindow>();

  return {
    failed(error) {
      const at = options.now();
      const cause = causeOf(error);
      if (failures === 0) {
        firstFailureAt = at;
      }
      failures += 1;
      const window = windows.get(cause);
      if (window !== undefined && at - window.loggedAt < FAILURE_LOG_WINDOW_MS) {
        window.suppressed += 1;
        return;
      }
      options.logger.error(
        { err: error, failures, suppressed: window?.suppressed ?? 0 },
        options.failureMessage,
      );
      windows.delete(cause);
      if (windows.size >= MAX_TRACKED_FAILURE_CAUSES) {
        const oldest = windows.keys().next();
        if (oldest.done !== true) {
          windows.delete(oldest.value);
        }
      }
      windows.set(cause, { loggedAt: at, suppressed: 0 });
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
      windows.clear();
    },
  };
}

function causeOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
