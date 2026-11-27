import { randomUUID } from "node:crypto";
import { DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import { silentLogger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import { createCaller } from "../routers/_app";
import type { TRPCContext } from "../trpc";
import { createBrowserCookies } from "./browser-cookies";

const unused = (name: string) => () => {
  throw new Error(`${name} is not used here`);
};

/**
 * A tRPC caller for an operator (`isAdmin`, or not with `isAdmin: false`) over the test's
 * database at `now`. Every other dependency throws when touched, so a test states what it uses.
 */
export function adminCaller(
  db: () => PrismaClient,
  now: Date,
  overrides: Partial<TRPCContext> = {},
) {
  const sessionId = randomUUID().replaceAll("-", "");
  return createCaller({
    now: () => now,
    principal: { kind: "guest", sessionId },
    isAdmin: true,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger: silentLogger,
    metrics: unused("metrics"),
    metricsReader: unused("metricsReader"),
    metricsReset: unused("metricsReset"),
    rateLimiter: unused("rateLimiter"),
    workerHealth: unused("workerHealth"),
    queueStore: () => Promise.reject(new Error("queueStore is not used here")),
    random: { next: () => 0 },
    admissionTokens: createBrowserCookies("d".repeat(32)).admissionTokens(sessionId, now),
    ...overrides,
  });
}
