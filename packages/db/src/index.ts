import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "./generated/prisma/client";

export type { OutboxEvent, OutboxStatus } from "./generated/prisma/client";
export { PrismaClient };

/**
 * Builds a Prisma client over Neon's serverless driver.
 *
 * The connection string is injected rather than read from `process.env` here so that the
 * caller owns configuration (and its validation), and tests can point at a throwaway branch
 * database without monkey-patching the environment.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (connectionString.trim() === "") {
    throw new Error("createPrismaClient: connectionString must be a non-empty Postgres URL");
  }
  return new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
}
