import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
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
export { seedCatalog } from "./seed";
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
}: PrismaClientOptions): PrismaClient {
  if (connectionString.trim() === "") {
    throw new Error("createPrismaClient: connectionString must be a non-empty Postgres URL");
  }
  const adapter =
    driver === "neon"
      ? new PrismaNeon({ connectionString })
      : new PrismaPg({
          connectionString,
          ...(poolMax === undefined ? {} : { max: poolMax }),
          ...(acquireTimeoutMs === undefined ? {} : { connectionTimeoutMillis: acquireTimeoutMs }),
        });
  return new PrismaClient({
    adapter,
    ...(transaction === undefined
      ? {}
      : { transactionOptions: { maxWait: transaction.maxWaitMs, timeout: transaction.timeoutMs } }),
  });
}

/** The client handed to an interactive `$transaction` callback. */
export type TransactionClient = Prisma.TransactionClient;
