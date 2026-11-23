import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { neonConfig } from "@neondatabase/serverless";
import { createPrismaClient, type DatabaseDriver } from "@ticketarena/db";
import { describe, expect, test } from "vitest";
import { BookingBusyError, type BookingMetric, createBookingService } from "./booking-service";
import { recordingMetrics } from "./testing";

// pg-pool's (and the Neon pool's) wording when opening a connection outlives
// `connectionTimeoutMillis`; a connection failure, unlike the queue timeout that means saturation.
const CONNECT_TIMEOUT = "Connection terminated due to connection timeout";
const ACQUIRE_TIMEOUT_MS = 300;
// Generous slack for a loaded machine; without the timeout the call never settles at all.
const BOUND_MS = ACQUIRE_TIMEOUT_MS + 2_000;

/** A TCP listener that accepts connections and never answers a byte. */
async function silentListener(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("silentListener: no TCP address");
  }
  return {
    port: address.port,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Holds through a service whose database never answers; the outcome, with how long it took. */
async function holdAgainst(connectionString: string, driver: DatabaseDriver) {
  const db = createPrismaClient({ connectionString, driver, acquireTimeoutMs: ACQUIRE_TIMEOUT_MS });
  const recorder = recordingMetrics<BookingMetric>();
  const booking = createBookingService({
    db,
    clock: { now: () => new Date() },
    newId: randomUUID,
    metrics: recorder.metrics,
  });
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the ${driver} client did not fail within ${BOUND_MS} ms`)),
      BOUND_MS,
    );
  });
  try {
    const error = await Promise.race([
      booking.holdSeats({ sessionId: "s", buyerKey: "s" }, randomUUID(), [randomUUID()]).then(
        () => new Error("the hold succeeded against a silent server"),
        (e: unknown) => e,
      ),
      deadline,
    ]);
    return { error, elapsedMs: Date.now() - startedAt, counted: recorder.names() };
  } finally {
    clearTimeout(timer);
    await db.$disconnect().catch(() => undefined);
  }
}

describe("a connection that never opens is not saturation", () => {
  test("pg: fails within the acquire timeout with the connect-timeout message, internal and uncounted", async () => {
    const listener = await silentListener();
    try {
      const { error, elapsedMs, counted } = await holdAgainst(
        `postgresql://user:pass@127.0.0.1:${listener.port}/db`,
        "pg",
      );

      expect(error).toMatchObject({ message: CONNECT_TIMEOUT });
      expect(error).not.toBeInstanceOf(BookingBusyError);
      expect(elapsedMs).toBeLessThan(BOUND_MS);
      expect(counted).toEqual([]);
    } finally {
      await listener.close();
    }
  }, 10_000);

  test("neon: fails within the acquire timeout with the connect-timeout message, internal and uncounted", async () => {
    const listener = await silentListener();
    const { wsProxy, useSecureWebSocket } = neonConfig;
    try {
      neonConfig.wsProxy = () => `127.0.0.1:${listener.port}/v2`;
      neonConfig.useSecureWebSocket = false;

      const { error, elapsedMs, counted } = await holdAgainst(
        "postgresql://user:pass@db.example.invalid/db",
        "neon",
      );

      expect(error).toMatchObject({ message: CONNECT_TIMEOUT });
      expect(error).not.toBeInstanceOf(BookingBusyError);
      expect(elapsedMs).toBeLessThan(BOUND_MS);
      expect(counted).toEqual([]);
    } finally {
      neonConfig.wsProxy = wsProxy;
      neonConfig.useSecureWebSocket = useSecureWebSocket;
      await listener.close();
    }
  }, 10_000);
});
