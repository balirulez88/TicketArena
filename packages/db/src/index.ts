import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client";

export type {
  Event,
  Hold,
  HoldStatus,
  Order,
  OrderLine,
  OrderStatus,
  OutboxEvent,
  OutboxStatus,
  ProcessedMessage,
  Seat,
  SeatStatus,
  Section,
  Venue,
} from "./generated/prisma/client";
export { PrismaClient };

/**
 * `pg` speaks the Postgres wire protocol over TCP (local, tests, the long-running worker);
 * `neon` uses Neon's serverless driver, which suits short-lived Vercel functions.
 */
export type DatabaseDriver = "pg" | "neon";

export interface PrismaClientOptions {
  readonly connectionString: string;
  readonly driver: DatabaseDriver;
  /** `pg` pool size; defaults to the driver's. Size it for the concurrency you expect. */
  readonly poolMax?: number;
  /** How long a caller waits for a free pooled connection before failing (`pg` only). */
  readonly acquireTimeoutMs?: number;
  /** Interactive-transaction start wait and total runtime, in ms (Prisma defaults 2000/5000). */
  readonly transaction?: { readonly maxWaitMs: number; readonly timeoutMs: number };
  /**
   * Handed the `pg` pool's live counters once it exists (`pg` only). Lets a test see that a caller
   * is queued for a connection instead of guessing with a round trip.
   */
  readonly observePool?: (pool: PoolCounters) => void;
}

/** Live counters of a `pg` pool; each read is current. */
export interface PoolCounters {
  /** Callers waiting for a pooled connection. */
  readonly waitingCount: number;
}

/**
 * Builds a Prisma client over the requested driver adapter.
 *
 * Both the URL and the driver are injected rather than read from `process.env`, so the caller
 * owns configuration (and its validation), and tests can point at a throwaway database.
 */
export function createPrismaClient({
  connectionString,
  driver,
  poolMax,
  acquireTimeoutMs,
  transaction,
  observePool,
}: PrismaClientOptions): PrismaClient {
  if (connectionString.trim() === "") {
    throw new Error("createPrismaClient: connectionString must be a non-empty Postgres URL");
  }
  // Both pools are pg-pool shaped: `connectionTimeoutMillis` bounds the wait for a pooled
  // connection and also the opening of a new one, so neither driver can wait indefinitely.
  const timeout =
    acquireTimeoutMs === undefined ? {} : { connectionTimeoutMillis: acquireTimeoutMs };
  const pgPool = () => {
    // Built here rather than by the adapter so its counters can be observed; the adapter still
    // owns it and ends it on `$disconnect`.
    const pool = new Pool({
      connectionString,
      ...(poolMax === undefined ? {} : { max: poolMax }),
      ...timeout,
    });
    observePool?.(pool);
    return new PrismaPg(pool, { disposeExternalPool: true });
  };
  const adapter = driver === "neon" ? new PrismaNeon({ connectionString, ...timeout }) : pgPool();
  return new PrismaClient({
    adapter,
    ...(transaction === undefined
      ? {}
      : { transactionOptions: { maxWait: transaction.maxWaitMs, timeout: transaction.timeoutMs } }),
  });
}

/** The client handed to an interactive `$transaction` callback. */
export type TransactionClient = Prisma.TransactionClient;
