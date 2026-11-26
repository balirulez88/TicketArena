import type { Logger } from "@ticketarena/contracts";

/**
 * How long a worker asked to stop waits for its components before it gives up and exits non-zero.
 * Below Fly's `kill_timeout` (30 s, `infra/fly/worker/fly.toml`) so the worker reports what hung
 * before the orchestrator kills it. A relay tick may hold its claim transaction for up to 60 s;
 * exiting drops the connection, Postgres rolls the claim back and the rows stay `PENDING`.
 */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;

/** One part of the running worker or one of its resources, named for the shutdown logs. */
export interface WorkerComponent {
  readonly name: string;
  stop(): Promise<void> | void;
}

/** Stop order: phases one after another, the components of a phase together. */
export type StopPhases = readonly (readonly WorkerComponent[])[];

export interface StopFailure {
  readonly component: string;
  readonly error: unknown;
}

interface StopProgress {
  /** Components of the current phase whose stop has not settled yet. */
  readonly pending: Set<string>;
  readonly failures: StopFailure[];
}

/**
 * Stops every component even when some fail: a failed stop must not leave later components (the
 * bus, the database pool) open. Never rejects; failures are collected in `progress`.
 */
export async function stopPhases(
  phases: StopPhases,
  progress: StopProgress = { pending: new Set(), failures: [] },
): Promise<readonly StopFailure[]> {
  for (const phase of phases) {
    await Promise.all(
      phase.map(async (component) => {
        progress.pending.add(component.name);
        try {
          await component.stop();
        } catch (error) {
          progress.failures.push({ component: component.name, error });
        } finally {
          progress.pending.delete(component.name);
        }
      }),
    );
  }
  return progress.failures;
}

/** Stops `phases` within `deadlineMs`, logging every failure and what is still pending at the deadline. */
async function stopWithin(
  phases: StopPhases,
  logger: Logger,
  deadlineMs: number,
): Promise<boolean> {
  const progress: StopProgress = { pending: new Set(), failures: [] };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
  });
  const outcome = await Promise.race([stopPhases(phases, progress), deadline]);
  clearTimeout(timer);
  for (const failure of progress.failures) {
    logger.error(
      { err: failure.error, component: failure.component },
      `worker component ${failure.component} failed to stop`,
    );
  }
  if (outcome === "deadline") {
    const pending = [...progress.pending];
    logger.error(
      { pending, deadlineMs },
      `worker did not stop within ${deadlineMs} ms: ${pending.join(", ")}`,
    );
    return false;
  }
  return progress.failures.length === 0;
}

interface ProcessOptions {
  readonly logger: Logger;
  /** `process.exit` in production; the process boundary, injected so tests observe the code. */
  readonly exit: (code: number) => void;
  readonly deadlineMs?: number;
}

export interface StartWorkerProcessOptions<Worker> extends ProcessOptions {
  readonly start: () => Promise<Worker>;
  /** What the entry point opened before `start` (bus, Redis, database), closed if start fails. */
  readonly resources: StopPhases;
}

/**
 * Starts the worker; a failed start is logged, the resources are closed and the process exits 1,
 * so a port in use is a reported error rather than an uncaught exception. `startWorker` has
 * already stopped whatever it started before it rejects (TD-034).
 */
export async function startWorkerProcess<Worker>(
  options: StartWorkerProcessOptions<Worker>,
): Promise<Worker | undefined> {
  try {
    return await options.start();
  } catch (error) {
    options.logger.error({ err: error }, "worker failed to start");
    await stopWithin(
      options.resources,
      options.logger,
      options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
    );
    options.exit(1);
    return undefined;
  }
}

export interface ShutdownWorkerProcessOptions extends ProcessOptions {
  /** The worker's components followed by the resources, in stop order. */
  readonly phases: StopPhases;
}

/**
 * The signal handler's body (TD-035): never rejects, exits 0 only when everything stopped, and
 * exits 1 at the deadline even if a stop never settles.
 */
export async function shutdownWorkerProcess(options: ShutdownWorkerProcessOptions): Promise<void> {
  const clean = await stopWithin(
    options.phases,
    options.logger,
    options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
  );
  options.exit(clean ? 0 : 1);
}
