import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@ticketarena/db";
import {
  type ConsumerRunnerOptions,
  createConsumerRunner,
  createOutboxRelay,
  type MessageBus,
  type OutboxRelayOptions,
} from "@ticketarena/messaging";

export interface WorkerOptions {
  readonly bus: MessageBus;
  readonly prisma: PrismaClient;
  readonly port: number;
  readonly relay?: Pick<OutboxRelayOptions, "intervalMs" | "batchSize">;
  /** Durable consumers this worker hosts; services register theirs here. */
  readonly consumers?: readonly Omit<ConsumerRunnerOptions, "bus" | "prisma">[];
}

export interface RunningWorker {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  // The relay must never publish into a stream that does not exist yet (ADR 0004).
  await options.bus.ensureTopology();

  const runners = await Promise.all(
    (options.consumers ?? []).map((consumer) =>
      createConsumerRunner({ ...consumer, bus: options.bus, prisma: options.prisma }),
    ),
  );
  const relay = createOutboxRelay({
    bus: options.bus,
    prisma: options.prisma,
    ...options.relay,
  });
  for (const runner of runners) {
    runner.start();
  }
  relay.start();

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
      await relay.stop();
      await Promise.all(runners.map((runner) => runner.stop()));
    },
  };
}
