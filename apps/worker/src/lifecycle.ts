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

/**
 * One deadline shared by every stop drawn from it (Q10: one 25 s budget). The clock starts at the
 * first `stop`, so a failed start's worker cleanup and the resource closes after it end within one
 * `deadlineMs`, never one deadline each.
 */
export interface StopBudget {
  /**
   * Stops `phases` before the shared deadline, logging every failure and what is still pending at
   * the deadline; resolves `true` only when everything stopped. Never rejects. A stop still pending
   * at the deadline keeps running unobserved: the caller exits or reports instead of waiting on it.
   */
  stop(phases: StopPhases, logger: Logger): Promise<boolean>;
}

export function createStopBudget(deadlineMs: number): StopBudget {
  let deadline: Promise<"deadline"> | undefined;
  return {
    async stop(phases, logger) {
      deadline ??= new Promise((resolve) => {
        // Unref'd: an embedded worker whose cleanup finished early must not be kept alive by it.
        setTimeout(() => resolve("deadline"), deadlineMs).unref();
      });
      const progress: StopProgress = { pending: new Set(), failures: [] };
      const outcome = await Promise.race([stopPhases(phases, progress), deadline]);
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
    },
  };
}

interface ProcessOptions {
  readonly logger: Logger;
  /** `process.exit` in production; the process boundary, injected so tests observe the code. */
  readonly exit: (code: number) => void;
  readonly deadlineMs?: number;
}

export interface StartWorkerProcessOptions<Worker> extends ProcessOptions {
  /**
   * Opens the resources (bus, Redis, database) and starts the worker. Each resource is handed to
   * `opened` the moment it exists, so a failure at any later step, a NATS connect included, closes
   * exactly what is open. `stopBudget` is the failed start's one deadline: `startWorker` stops what
   * it started from it, and the resources are then closed from what is left.
   */
  readonly start: (
    opened: (resource: WorkerComponent) => void,
    stopBudget: StopBudget,
  ) => Promise<Worker>;
}

export interface StartedWorkerProcess<Worker> {
  readonly worker: Worker;
  /** The opened resources in stop order (reverse order of opening), one per phase. */
  readonly resources: StopPhases;
}

/**
 * Starts the worker; a failed start is logged, the resources opened so far are closed and the
 * process exits 1, so a port in use or an unreachable NATS is a reported error rather than an
 * uncaught exception. The whole failed-start cleanup, `startWorker`'s own (TD-034) included, ends
 * within one `deadlineMs`.
 */
export async function startWorkerProcess<Worker>(
  options: StartWorkerProcessOptions<Worker>,
): Promise<StartedWorkerProcess<Worker> | undefined> {
  const opened: WorkerComponent[] = [];
  // Later resources depend on earlier ones (the bus relays from the database), so close newest first.
  const resources = (): StopPhases => opened.toReversed().map((resource) => [resource]);
  const stopBudget = createStopBudget(options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS);
  try {
    const worker = await options.start((resource) => {
      opened.push(resource);
    }, stopBudget);
    return { worker, resources: resources() };
  } catch (error) {
    options.logger.error({ err: error }, "worker failed to start");
    await stopBudget.stop(resources(), options.logger);
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
  const clean = await createStopBudget(options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS).stop(
    options.phases,
    options.logger,
  );
  options.exit(clean ? 0 : 1);
}
