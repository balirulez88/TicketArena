import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export type {
  Event,
  Hold,
  HoldStatus,
  OutboxEvent,
  OutboxStatus,
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
}: PrismaClientOptions): PrismaClient {
  if (connectionString.trim() === "") {
    throw new Error("createPrismaClient: connectionString must be a non-empty Postgres URL");
  }
  const adapter =
    driver === "neon" ? new PrismaNeon({ connectionString }) : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
