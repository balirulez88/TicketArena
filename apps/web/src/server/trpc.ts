import { randomUUID } from "node:crypto";
import {
  BOOKING_ACQUIRE_TIMEOUT_MS,
  type BookingMetrics,
  type BookingMetricsReader,
  type BookingMetricsReset,
  type BookingService,
  type BookingTimeouts,
  bookingTransactionOptions,
  createBookingService,
  DEFAULT_BOOKING_TIMEOUTS,
} from "@ticketarena/booking";
import type { Logger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, type PrismaClientOptions } from "@ticketarena/db";
import type { QueueStore, Random } from "@ticketarena/waiting-room";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { type AdmissionTokens, admissionSetCookie, createAdmissionTokens } from "./admission-token";
import { parseAdmissionEnv, parseDatabaseEnv, parseSessionEnv } from "./env";
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
  /**
   * The timeouts `db` was built with: both come from one `BookingRuntime`, so the services
   * `bookingServiceFor` builds never wait longer than the client's transaction budget allows.
   */
  readonly bookingTimeouts: BookingTimeouts;
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
  /**
   * Signs admission tokens into per-event cookies on the response and reads verified ones from
   * the request; `ADMISSION_SECRET` is read on first use, so other procedures never need it.
   */
  readonly admissionTokens: AdmissionTokens;
}

export interface BookingComposition {
  readonly client: PrismaClientOptions;
  readonly timeouts: BookingTimeouts;
}

/**
 * One timeouts value builds both the Prisma client (its transaction budget and acquire timeout)
 * and the booking services (their `SET LOCAL` values and retries), so the budget always covers
 * what the transactions may wait.
 */
export function composeBooking(
  { DATABASE_URL, DATABASE_DRIVER }: ReturnType<typeof parseDatabaseEnv>,
  timeouts: BookingTimeouts = DEFAULT_BOOKING_TIMEOUTS,
): BookingComposition {
  return {
    client: {
      connectionString: DATABASE_URL,
      driver: DATABASE_DRIVER,
      acquireTimeoutMs: BOOKING_ACQUIRE_TIMEOUT_MS,
      transaction: bookingTransactionOptions(timeouts),
    },
    timeouts,
  };
}

/** A client and the timeouts it was built for; a request context takes both from one runtime. */
export interface BookingRuntime {
  readonly db: PrismaClient;
  readonly timeouts: BookingTimeouts;
}

export function connectBooking(composition: BookingComposition): BookingRuntime {
  return { db: createPrismaClient(composition.client), timeouts: composition.timeouts };
}

// One client per server process: the Neon driver pools internally, and a fresh client per
// request would open a new connection pool on every call.
let shared: BookingRuntime | undefined;

function sharedBooking(): BookingRuntime {
  if (shared === undefined) {
    shared = connectBooking(composeBooking(parseDatabaseEnv(process.env)));
  }
  return shared;
}

/** A booking service over the request's client and clock, with the timeouts that client fits. */
export function bookingServiceFor(
  ctx: Pick<TRPCContext, "db" | "now" | "logger" | "bookingTimeouts">,
  metrics?: BookingMetrics,
): BookingService {
  return createBookingService({
    db: ctx.db,
    clock: { now: ctx.now },
    newId: randomUUID,
    logger: ctx.logger,
    timeouts: ctx.bookingTimeouts,
    ...(metrics === undefined ? {} : { metrics }),
  });
}

const logger = createWebLogger();

const metrics = createLazyMetrics({ readEnv: () => process.env, logger });

const metricsReader = createLazyMetricsReader({ readEnv: () => process.env, logger });

const metricsReset = createLazyMetricsReset({ readEnv: () => process.env, logger });

const rateLimiter = createLazyAdminRateLimiter({ readEnv: () => process.env, logger });

const queueStore = createLazyQueueStore({ readEnv: () => process.env, logger, prefix: "" });

const random: Random = { next: () => Math.random() };

export interface ContextRequest {
  readonly req: Request;
  /** The response's headers; admission cookies are appended to them. */
  readonly resHeaders: Headers;
}

/**
 * Builds the per-request context over a booking runtime resolved on first use, so the request's
 * `db` and `bookingTimeouts` always come from the same composition.
 */
export function createTRPCContextFactory(
  booking: () => BookingRuntime,
): (request: ContextRequest) => Promise<TRPCContext> {
  return (request) => buildContext(request, booking);
}

export const createTRPCContext = createTRPCContextFactory(sharedBooking);

async function buildContext(
  { req, resHeaders }: ContextRequest,
  booking: () => BookingRuntime,
): Promise<TRPCContext> {
  const { SESSION_SECRET } = parseSessionEnv(process.env);
  const identity = createIdentityService({ sessionSecret: SESSION_SECRET });
  const cookies = cookieReader(req.headers.get("cookie"));
  const principal = await identity.resolve(cookies);
  const isAdmin = await verifyAdminCookieValue(
    SESSION_SECRET,
    cookies.get(ADMIN_COOKIE)?.value,
    new Date(),
  );
  const now = () => new Date();
  const { db, timeouts } = booking();
  return {
    now,
    principal,
    isAdmin,
    db,
    bookingTimeouts: timeouts,
    logger,
    metrics,
    metricsReader,
    metricsReset,
    rateLimiter,
    queueStore,
    random,
    admissionTokens: createAdmissionTokens({
      secret: () => parseAdmissionEnv(process.env).ADMISSION_SECRET,
      cookies,
      setCookie: (cookie) => resHeaders.append("set-cookie", admissionSetCookie(cookie)),
      now,
    }),
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

/**
 * Procedures only an admitted buyer may call (ADR 0008; only `booking.holdSeats`). The input must
 * carry `eventId`. The token's signature and `exp` are checked by `admissionTokens.read`; here
 * `sub` must be this session, `eid` the requested event, and the `jti` still in the event's
 * admitted set, so an admission revoked by a freed slot stops working at once. Redis is consulted
 * last and its failure fails the call: seats are never held on an unverified admission.
 */
export const admittedProcedure = t.procedure
  .input(z.object({ eventId: z.uuid() }))
  .use(async ({ ctx, input, next }) => {
    const claims = await ctx.admissionTokens.read(input.eventId);
    const admitted =
      claims !== undefined &&
      claims.sessionId === ctx.principal.sessionId &&
      claims.eventId === input.eventId &&
      (await (await ctx.queueStore()).isAdmitted(input.eventId, claims.jti, ctx.now()));
    if (!admitted) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `No valid admission for event ${input.eventId}; join its queue first`,
      });
    }
    return next();
  });
