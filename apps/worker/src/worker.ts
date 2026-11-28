import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BookingService } from "@ticketarena/booking";
import { type Logger, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import {
  type ConsumerRunnerOptions,
  createConsumerRunner,
  createOutboxRelay,
  type DeliveryHealth,
  type MessageBus,
  type OutboxFailureMetrics,
  type OutboxRelayOptions,
  pruneRetention,
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

/** How often the retention job deletes outbox rows and processed_messages past 14 days (ADR 0011). */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

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
  /**
   * The retention job (`pruneRetention`): `now` is the clock it ages rows by. Deleting is never
   * urgent, so it runs hourly; a failed pass is retried by the next one.
   */
  readonly retention?: {
    readonly now: () => Date;
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
   * Dependencies `/health` reports on separately, each a probe that rejects when the dependency is
   * unreachable. Redis is reported, never required: the worker runs without it.
   * `outbox` reads the FAILED outbox metrics (`measureOutboxFailures`) for the alert flag;
   * `delivery` reads the broker's consumer and DLQ figures (`deliveryHealth`) for the dashboard.
   * `deadlinesMs` bounds each probe; one that misses its deadline is reported `unavailable`.
   * Each defaults to `DEFAULT_HEALTH_PROBE_DEADLINE_MS`.
   */
  readonly health?: {
    readonly redis?: () => Promise<unknown>;
    readonly outbox?: () => Promise<Record<ServiceName, OutboxFailureMetrics>>;
    readonly delivery?: () => Promise<DeliveryHealth>;
    readonly deadlinesMs?: Partial<Record<HealthProbeName, number>>;
  };
  /**
   * The deadline for stopping what a failed start already started, after which the start error
   * propagates anyway. `startWorkerProcess` passes the failed start's one budget so the resource
   * closes share it; defaults to a fresh `DEFAULT_SHUTDOWN_DEADLINE_MS` budget.
   */
  readonly stopBudget?: StopBudget;
}

export type HealthProbeName = "redis" | "outbox" | "delivery";

/**
 * The default deadline of each `/health` probe. `/health` is the Fly liveness check, whose timeout
 * is 5 s (infra/fly/worker/fly.toml); the probes run concurrently, so the whole answer takes at
 * most one deadline, well inside it. Without it a hung dependency (a JetStream API call waits 5 s
 * by default) would make the platform fail the check and restart a worker that is fine.
 */
export const DEFAULT_HEALTH_PROBE_DEADLINE_MS = 2000;

const UNAVAILABLE = Symbol("unavailable");

/** Settles with the probe's value, or `UNAVAILABLE` when it rejects, throws or misses `deadlineMs`. */
function withinDeadline<T>(
  probe: () => Promise<T>,
  deadlineMs: number,
): Promise<T | typeof UNAVAILABLE> {
  return new Promise((resolve) => {
    // A probe that settles after its deadline is ignored; its late rejection is still handled.
    const timer = setTimeout(() => resolve(UNAVAILABLE), deadlineMs);
    Promise.resolve()
      .then(probe)
      .then(
        (value) => resolve(value),
        () => resolve(UNAVAILABLE),
      )
      .finally(() => clearTimeout(timer));
  });
}

/**
 * `/health`: the worker itself is up (`status` is always `ok`, so neither a dependency nor a FAILED
 * outbox row ever fails liveness); Redis, when probed, is `ok` or `unavailable`; the outbox, when
 * measured, carries the FAILED metrics per service and `alert`, set while any row is FAILED; the
 * delivery figures, when probed, are the broker's consumer lag, pending acks, redeliveries and DLQ
 * size and age, or `unavailable`. Every part is optional and added, never changed, so existing
 * readers of `/health` keep working. The probes run concurrently, each bounded by its own deadline.
 */
async function healthReport(health: WorkerOptions["health"]): Promise<object> {
  const deadlineOf = (name: HealthProbeName): number =>
    health?.deadlinesMs?.[name] ?? DEFAULT_HEALTH_PROBE_DEADLINE_MS;
  const [redis, outbox, delivery] = await Promise.all([
    health?.redis === undefined
      ? {}
      : withinDeadline(health.redis, deadlineOf("redis")).then((answer) => ({
          redis: answer === UNAVAILABLE ? "unavailable" : "ok",
        })),
    health?.outbox === undefined
      ? {}
      : withinDeadline(health.outbox, deadlineOf("outbox")).then((services) => ({
          outbox:
            services === UNAVAILABLE
              ? "unavailable"
              : {
                  alert: Object.values(services).some((metrics) => metrics.failed > 0),
                  services,
                },
        })),
    health?.delivery === undefined
      ? {}
      : withinDeadline(health.delivery, deadlineOf("delivery")).then((figures) => ({
          delivery: figures === UNAVAILABLE ? "unavailable" : figures,
        })),
  ]);
  return { status: "ok", ...redis, ...outbox, ...delivery };
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
  startRetention(options, started.sweepers);
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

/** Stopped in the sweepers' phase too: it only deletes rows nothing will read again. */
function startRetention(options: WorkerOptions, jobs: WorkerComponent[]): void {
  const retention = options.retention;
  if (retention === undefined) {
    return;
  }
  const logger = options.logger ?? silentLogger;
  const loop = createPeriodicLoop({
    task: async () => {
      const pruned = await pruneRetention({ prisma: options.prisma, now: retention.now() });
      if (Object.values(pruned).some((rows) => rows.outbox + rows.processed > 0)) {
        logger.info({ pruned }, "retention job deleted rows past the retention");
      }
    },
    intervalMs: retention.intervalMs ?? RETENTION_INTERVAL_MS,
    logger,
    failureMessage: "retention job failed; will retry",
  });
  loop.start();
  jobs.push({ name: "retention job", stop: () => loop.stop() });
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
