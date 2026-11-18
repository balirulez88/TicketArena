import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BookingService } from "@ticketarena/booking";
import { type Logger, silentLogger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import {
  type ConsumerRunnerOptions,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
  type OutboxRelayOptions,
} from "@ticketarena/messaging";
import { createSweeperLoop } from "./sweeper.js";

/** How often expired holds and overdue orders are swept (spec: Expiry); lazy expiry covers held seats in between. */
export const SWEEP_INTERVAL_MS = 15_000;

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
}

export interface RunningWorker {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  // The relay must never publish into a stream that does not exist yet (ADR 0004).
  await options.bus.ensureTopology();

  // exactOptionalPropertyTypes forbids passing `logger: undefined`; omit it so packages default.
  const loggerOption = options.logger === undefined ? {} : { logger: options.logger };

  const runners = await Promise.all(
    (options.consumers ?? []).map((consumer) =>
      createConsumerRunner({
        ...consumer,
        bus: options.bus,
        prisma: options.prisma,
        ...loggerOption,
      }),
    ),
  );
  // One relay per service outbox (ADR 0009).
  const relays = (["booking", "payment", "notification"] as const).map((service) =>
    createOutboxRelay({
      bus: options.bus,
      prisma: options.prisma,
      service,
      ...loggerOption,
      ...options.relay,
    }),
  );
  const sweeper =
    options.sweeper === undefined
      ? undefined
      : createSweeperLoop({
          booking: options.sweeper.booking,
          intervalMs: options.sweeper.intervalMs ?? SWEEP_INTERVAL_MS,
          logger: options.logger ?? silentLogger,
        });
  for (const runner of runners) {
    runner.start();
  }
  sweeper?.start();
  for (const relay of relays) {
    relay.start();
  }

  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(options.port, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sweeper?.stop();
      await Promise.all(relays.map((relay) => relay.stop()));
      await Promise.all(runners.map((runner) => runner.stop()));
    },
  };
}
