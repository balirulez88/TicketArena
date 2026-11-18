import type {
  BookingMetrics,
  BookingMetricsReader,
  BookingMetricsReset,
} from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import type { QueueStore, Random } from "@ticketarena/waiting-room";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { parseDatabaseEnv, parseSessionEnv } from "./env";
import { ADMIN_COOKIE, verifyAdminCookieValue } from "./identity/admin-session";
import { type CookieReader, createIdentityService, type Principal } from "./identity/identity";
import { createWebLogger } from "./logger";
import { createLazyQueueStore } from "./queue-store";
import type { RateLimiter } from "./rate-limiter";
import {
  createLazyAdminRateLimiter,
  createLazyMetrics,
  createLazyMetricsReader,
  createLazyMetricsReset,
} from "./upstash-metrics";

/**
 * Per-request context. Infrastructure (clock, and later db/redis/outbox) is injected here
 * instead of imported inside procedures, so routers stay pure functions of their context and
 * tests can drive them through `createCaller` with deterministic fakes.
 */
export interface TRPCContext {
  readonly now: () => Date;
  /** Resolved once per request; procedures never read cookies themselves (ADR 0012). */
  readonly principal: Principal;
  /**
   * `true` only for a validly signed, unexpired `ta_admin` cookie. Separate from the Principal on
   * purpose: operator access is not a buyer identity (ADR 0012). Checked by `adminProcedure`.
   */
  readonly isAdmin: boolean;
  readonly db: PrismaClient;
  /** Created at the app boundary; procedures bind booking ids on top of it. */
  readonly logger: Logger;
  /**
   * Resolved on first call and cached per process, so the Upstash variables are read only by
   * procedures that record metrics; throws when that configuration is invalid.
   */
  readonly metrics: () => BookingMetrics;
  /** Reads the same counters for the admin snapshot; resolved lazily like `metrics`. */
  readonly metricsReader: () => BookingMetricsReader;
  /** Zeroes an event's counters for the demo reset; resolved lazily like `metrics`. */
  readonly metricsReset: () => BookingMetricsReset;
  /** Limits the destructive admin actions globally; resolved lazily like `metrics`. */
  readonly rateLimiter: () => RateLimiter;
  /**
   * The waiting-room queue store, connected on first call and shared per process, so `REDIS_URL`
   * is read only by the queue procedures; rejects when that configuration is invalid.
   */
  readonly queueStore: () => Promise<QueueStore>;
  /** Randomness for pre-queue positions; injected so tests can script it. */
  readonly random: Random;
}

// One client per server process: the Neon driver pools internally, and a fresh client per
// request would open a new connection pool on every call.
let sharedDb: PrismaClient | undefined;

function database(): PrismaClient {
  if (sharedDb === undefined) {
    const { DATABASE_URL, DATABASE_DRIVER } = parseDatabaseEnv(process.env);
    sharedDb = createPrismaClient({ connectionString: DATABASE_URL, driver: DATABASE_DRIVER });
  }
  return sharedDb;
}

const logger = createWebLogger();

const metrics = createLazyMetrics({ readEnv: () => process.env, logger });

const metricsReader = createLazyMetricsReader({ readEnv: () => process.env, logger });

const metricsReset = createLazyMetricsReset({ readEnv: () => process.env, logger });

const rateLimiter = createLazyAdminRateLimiter({ readEnv: () => process.env, logger });

const queueStore = createLazyQueueStore({ readEnv: () => process.env, logger, prefix: "" });

const random: Random = { next: () => Math.random() };

export async function createTRPCContext({ req }: { req: Request }): Promise<TRPCContext> {
  const { SESSION_SECRET } = parseSessionEnv(process.env);
  const identity = createIdentityService({ sessionSecret: SESSION_SECRET });
  const cookies = cookieReader(req.headers.get("cookie"));
  const principal = await identity.resolve(cookies);
  const isAdmin = await verifyAdminCookieValue(
    SESSION_SECRET,
    cookies.get(ADMIN_COOKIE)?.value,
    new Date(),
  );
  return {
    now: () => new Date(),
    principal,
    isAdmin,
    db: database(),
    logger,
    metrics,
    metricsReader,
    metricsReset,
    rateLimiter,
    queueStore,
    random,
  };
}

// Parsed by hand: the tRPC fetch adapter hands us a plain Request, not Next's cookie store, and
// IdentityService only needs the narrow CookieReader seam.
function cookieReader(header: string | null): CookieReader {
  const cookies = new Map<string, string>();
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator > 0) {
      cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
  return {
    get: (name: string) => {
      const value = cookies.get(name);
      return value === undefined ? undefined : { value };
    },
  };
}

const t = initTRPC.context<TRPCContext>().create({
  // superjson keeps Date/Map/BigInt intact across the wire (booking timestamps, prices).
  transformer: superjson,
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

/** Operator-only procedures: rejected before any infrastructure is touched without `ta_admin`. */
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Admin login required" });
  }
  return next();
});
