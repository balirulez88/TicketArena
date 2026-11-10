import type { PrismaClient } from "@ticketarena/db";

// Generous for a cold connection on a loaded machine, and still inside Vitest's 30 s test timeout.
const DEFAULT_DEADLINE_MS = 15_000;
// Outlasts any saturation test, so Prisma cannot expire the occupation and free the connection
// while callers are still meant to find the pool full.
const OCCUPATION_TIMEOUT_MS = 25_000;
// Only spaces out retries of a failed start. Ordering never depends on it: callers wait for the
// occupier's signal.
const RETRY_PAUSE_MS = 25;

export interface OccupyOptions {
  /** Upper bound on holding a connection, across every attempt. */
  readonly deadlineMs?: number;
  /** Delays the occupier, not occupy's caller, so a test can prove callers wait for the signal. */
  readonly beforeStart?: () => Promise<void>;
  /** Told each time an attempt failed before its signal and is about to be tried again. */
  readonly onStartFailure?: (error: unknown) => void;
}

export interface Occupation {
  /** The Postgres backend holding the connection, observable in `pg_stat_activity`. */
  readonly backendPid: number;
  /** Ends the transaction and resolves once the connection is back in the pool. */
  readonly release: () => Promise<void>;
}

interface Attempt {
  /** Settles with the backend's pid after the query has run, or with why it never did. */
  readonly ready: Promise<number>;
  readonly release: () => Promise<void>;
}

function startAttempt(db: PrismaClient, started: Promise<void>, maxWaitMs: number): Attempt {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let signal: (pid: number) => void = () => undefined;
  let fail: (reason: unknown) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    signal = resolve;
    fail = reject;
  });

  const finished = started.then(() =>
    db.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (row === undefined) {
          throw new Error("occupy: pg_backend_pid() returned no row");
        }
        signal(row.pid);
        await gate;
      },
      // The client's own budget may be the short one under test; the occupier must not be bound
      // by it.
      { maxWait: maxWaitMs, timeout: OCCUPATION_TIMEOUT_MS },
    ),
  );
  finished.catch(fail);

  return {
    ready,
    release: () => {
      open();
      return finished;
    },
  };
}

const TIMED_OUT = Symbol("timed out");

function orTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/**
 * Holds one of the client's connections in an open transaction. Resolves only after the
 * transaction's query has run, so a test on a one-connection pool knows that the pool is full,
 * instead of guessing with a sleep.
 *
 * A pool's acquire timeout also bounds opening its first connection, so a short one can fail the
 * occupier's own start on a loaded machine. Any failure before the signal is retried until the
 * deadline: the occupier has not begun occupying, and the code under test has not run. A
 * persistent failure ends at the deadline, with the last one as the error's cause.
 */
export async function occupy(
  db: PrismaClient,
  { deadlineMs = DEFAULT_DEADLINE_MS, beforeStart, onStartFailure }: OccupyOptions = {},
): Promise<Occupation> {
  const started = beforeStart?.() ?? Promise.resolve();
  const deadline = Date.now() + deadlineMs;
  let lastFailure: unknown;

  for (let remaining = deadlineMs; remaining > 0; remaining = deadline - Date.now()) {
    const attempt = startAttempt(db, started, remaining);
    try {
      const backendPid = await orTimeout(attempt.ready, remaining);
      if (backendPid !== TIMED_OUT) {
        return { backendPid, release: attempt.release };
      }
      // An attempt still pending at the deadline must not take the connection later and keep it.
      attempt.release().catch(() => undefined);
      break;
    } catch (error) {
      lastFailure = error;
      onStartFailure?.(error);
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
  throw new Error(`occupy: did not hold a connection within ${deadlineMs} ms`, {
    cause: lastFailure,
  });
}
