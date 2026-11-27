import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BookingService } from "@ticketarena/booking";
import { type Logger, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import {
  type ConsumerRunnerOptions,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
  type OutboxFailureMetrics,
  type OutboxRelayOptions,
  type ServiceName,
} from "@ticketarena/messaging";
import type { AdmissionLimits, QueueService } from "@ticketarena/waiting-room";
import { createAdmissionLoops } from "./admission.js";
import {
  createStopBudget,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  type StopBudget,
  type StopPhases,
  stopPhases,
  type WorkerComponent,
} from "./lifecycle.js";
import { createPeriodicLoop } from "./periodic-loop.js";
import { createSweeperLoop } from "./sweeper.js";

/** How often expired holds and overdue orders are swept (spec: Expiry); lazy expiry covers held seats in between. */
export const SWEEP_INTERVAL_MS = 15_000;

/** How often the reconciler looks for stale refund obligations (spec: Refund obligations and reconciliation). */
export const RECONCILE_INTERVAL_MS = 5 * 60_000;

/** How often the admission ticker admits from each queue (spec: Waiting room). */
export const ADMIT_INTERVAL_MS = 1000;

/** How often idle slots and slots with an expired admission are reaped (spec: Waiting room). */
export const REAP_INTERVAL_MS = 15_000;

export interface WorkerOptions {
  readonly bus: MessageBus;
  readonly prisma: PrismaClient;
  readonly port: number;
  readonly logger?: Logger;
  readonly relay?: Pick<OutboxRelayOptions, "intervalMs" | "batchSize">;
  /** Durable consumers this worker hosts; services register theirs here. */
  readonly consumers?: readonly Omit<ConsumerRunnerOptions, "bus" | "prisma" | "logger">[];
  /** The sweeper of holds and orders; the booking service carries the clock it decides expiry with. */
  readonly sweeper?: {
    readonly booking: Pick<BookingService, "sweepExpired">;
    readonly intervalMs?: number;
  };
  /** The refund reconciler; the booking service carries its clock and its age and re-emit limits. */
  readonly reconciler?: {
    readonly booking: Pick<BookingService, "reconcileRefunds">;
    readonly intervalMs?: number;
  };
  /** The admission ticker and slot reaper; the queue service carries the clock they decide with. */
  readonly waitingRoom?: {
    readonly queue: Pick<QueueService, "admitTick" | "reap">;
    readonly limits: AdmissionLimits;
    readonly admitIntervalMs?: number;
    readonly reapIntervalMs?: number;
  };
  /**
   * Dependencies `/health` reports on separately, each a bounded probe that rejects when the
   * dependency is unreachable. Redis is reported, never required: the worker runs without it.
   * `outbox` reads the FAILED outbox metrics (`measureOutboxFailures`) for the alert flag.
   */
  readonly health?: {
    readonly redis?: () => Promise<unknown>;
    readonly outbox?: () => Promise<Record<ServiceName, OutboxFailureMetrics>>;
  };
  /**
   * The deadline for stopping what a failed start already started, after which the start error
   * propagates anyway. `startWorkerProcess` passes the failed start's one budget so the resource
   * closes share it; defaults to a fresh `DEFAULT_SHUTDOWN_DEADLINE_MS` budget.
   */
  readonly stopBudget?: StopBudget;
}

/**
 * `/health`: the worker itself is up (`status` is always `ok`, so neither a dependency nor a FAILED
 * outbox row ever fails liveness); Redis, when probed, is `ok` or `unavailable`; the outbox, when
 * measured, carries the FAILED metrics per service and `alert`, set while any row is FAILED.
 */
async function healthReport(health: WorkerOptions["health"]): Promise<object> {
  const redis =
    health?.redis === undefined
      ? {}
      : {
          redis: await health.redis().then(
            () => "ok",
            () => "unavailable",
          ),
        };
  const outbox =
    health?.outbox === undefined
      ? {}
      : {
          outbox: await health.outbox().then(
            (services) => ({
              alert: Object.values(services).some((metrics) => metrics.failed > 0),
              services,
            }),
            () => "unavailable",
          ),
        };
  return { status: "ok", ...redis, ...outbox };
}

export interface RunningWorker {
  readonly port: number;
  /** The started parts in stop order, named for the shutdown logs (`shutdownWorkerProcess`). */
  readonly components: StopPhases;
  /** Stops every component; rejects naming those whose stop failed. */
  stop(): Promise<void>;
}

/** Binds the health port, rejecting (never an unhandled 'error' event) when it cannot. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(
        new Error(`worker health server cannot listen on port ${port}: ${error.message}`, {
          cause: error,
        }),
      );
    };
    server.once("error", onError);
    server.listen(port, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function stopAll(phases: StopPhases): Promise<void> {
  const failures = await stopPhases(phases);
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `worker components failed to stop: ${failures.map((failure) => failure.component).join(", ")}`,
    );
  }
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  // The relay must never publish into a stream that does not exist yet (ADR 0004).
  await options.bus.ensureTopology();

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      void healthReport(options.health).then((report) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(report));
      });
      return;
    }
    response.writeHead(404).end();
  });
  // Bound before anything starts (TD-034): a port in use rejects with nothing to clean up.
  await listen(server, options.port);

  // Each loop is recorded the moment it starts, so a later failing step stops exactly what is
  // running before the error propagates, and no loop outlives a failed start.
  const started: StartedLoops = { sweepers: [], admission: [], relays: [], runners: [] };
  const components: StopPhases = [
    [{ name: "health server", stop: () => closeServer(server) }],
    started.sweepers,
    started.admission,
    started.relays,
    started.runners,
  ];
  try {
    await startLoops(options, started);
  } catch (error) {
    // Bounded: a stop that never settles (a runner's pull or a relay's claim transaction that
    // hangs) must not swallow the start error; the log names the component still stopping.
    const stopBudget = options.stopBudget ?? createStopBudget(DEFAULT_SHUTDOWN_DEADLINE_MS);
    await stopBudget.stop(components, options.logger ?? silentLogger);
    throw error;
  }

  return {
    port: (server.address() as AddressInfo).port,
    components,
    stop: () => stopAll(components),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

/** The started loops by stop phase; each array grows as its loops start. */
interface StartedLoops {
  readonly sweepers: WorkerComponent[];
  readonly admission: WorkerComponent[];
  readonly relays: WorkerComponent[];
  readonly runners: WorkerComponent[];
}

async function startLoops(options: WorkerOptions, started: StartedLoops): Promise<void> {
  // exactOptionalPropertyTypes forbids passing `logger: undefined`; omit it so packages default.
  const loggerOption = options.logger === undefined ? {} : { logger: options.logger };

  // One relay per service outbox (ADR 0009).
  for (const service of ["booking", "payment", "notification"] as const) {
    const relay = createOutboxRelay({
      bus: options.bus,
      prisma: options.prisma,
      service,
      ...loggerOption,
      ...options.relay,
    });
    relay.start();
    started.relays.push({ name: `relay:${service}`, stop: () => relay.stop() });
  }
  // allSettled, not all: every subscribe has finished, and its runner started, before a failure
  // propagates, so no runner starts after the caller's cleanup.
  const subscribed = await Promise.allSettled(
    (options.consumers ?? []).map(async (consumer) => {
      const runner = await createConsumerRunner({
        ...consumer,
        bus: options.bus,
        prisma: options.prisma,
        ...loggerOption,
      });
      runner.start();
      started.runners.push({ name: `consumer:${consumer.consumer}`, stop: () => runner.stop() });
    }),
  );
  const refused = subscribed.find((result) => result.status === "rejected");
  if (refused !== undefined) {
    throw refused.reason;
  }
  startSweeper(options, started.sweepers);
  startReconciler(options, started.sweepers);
  startAdmission(options, started.admission);
}

/** Stopped in the sweepers' phase: both are periodic database jobs that publish nothing themselves. */
function startReconciler(options: WorkerOptions, jobs: WorkerComponent[]): void {
  const reconciler = options.reconciler;
  if (reconciler === undefined) {
    return;
  }
  const loop = createPeriodicLoop({
    // A pass re-emits through the outbox only, so a failed pass loses nothing: the next one finds
    // the same stale obligations.
    task: async () => {
      await reconciler.booking.reconcileRefunds();
    },
    intervalMs: reconciler.intervalMs ?? RECONCILE_INTERVAL_MS,
    logger: options.logger ?? silentLogger,
    failureMessage: "refund reconciliation failed; will retry",
  });
  loop.start();
  jobs.push({ name: "refund reconciler", stop: () => loop.stop() });
}

function startSweeper(options: WorkerOptions, sweepers: WorkerComponent[]): void {
  if (options.sweeper === undefined) {
    return;
  }
  const sweeper = createSweeperLoop({
    booking: options.sweeper.booking,
    intervalMs: options.sweeper.intervalMs ?? SWEEP_INTERVAL_MS,
    logger: options.logger ?? silentLogger,
  });
  sweeper.start();
  sweepers.push({ name: "sweeper", stop: () => sweeper.stop() });
}

function startAdmission(options: WorkerOptions, admission: WorkerComponent[]): void {
  if (options.waitingRoom === undefined) {
    return;
  }
  const loops = createAdmissionLoops({
    queue: options.waitingRoom.queue,
    limits: options.waitingRoom.limits,
    prisma: options.prisma,
    admitIntervalMs: options.waitingRoom.admitIntervalMs ?? ADMIT_INTERVAL_MS,
    reapIntervalMs: options.waitingRoom.reapIntervalMs ?? REAP_INTERVAL_MS,
    logger: options.logger ?? silentLogger,
  });
  const names = ["admission ticker", "slot reaper"];
  for (const [index, loop] of loops.entries()) {
    loop.start();
    admission.push({ name: names[index] ?? `admission loop ${index}`, stop: () => loop.stop() });
  }
}
