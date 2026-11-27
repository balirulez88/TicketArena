import { randomUUID } from "node:crypto";
import {
  type BookingMetrics,
  type BookingTimeouts,
  createBookingService,
  DEFAULT_BOOKING_TIMEOUTS,
} from "@ticketarena/booking";
import {
  block,
  failureOf,
  freeSeats,
  occupy,
  rowLock,
  testClients,
  withClient,
  withTrigger,
} from "@ticketarena/booking/testing";
import type { Logger } from "@ticketarena/contracts";
import type { PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buyerKey, issueSessionCookieValue } from "../identity/identity";
import { type FakeUpstash, refusedUrl, startFakeUpstash } from "../testing/fake-upstash";
import {
  composeBooking,
  connectBooking,
  createContextServices,
  createTRPCContextFactory,
  type LazyBookingRuntime,
  type TRPCContext,
} from "../trpc";
import { createCaller } from "./_app";

// Ticket 57 (TD-070): the running app counts booking outcomes in Upstash. Everything here goes
// through the real context factory and the real Upstash client, over the test Postgres and the test
// Redis (waiting room); only the Upstash HTTP endpoint is a local fake.

const database = setupTestDatabase();
const redis = setupTestRedis();
const { db, open } = testClients(database);

const SESSION_SECRET = "s".repeat(32);
const ADMISSION_SECRET = "m".repeat(32);
const CONTACT = { email: "metrics.buyer@example.com" };
const API_URL = "https://ticketarena.example/api/trpc";

// The context's clock is the real one, so the catalog is seeded at the real instant: the demo
// event is on sale and its queue closed, which makes a join admit at once.
beforeAll(async () => {
  await withClient(database, (seeding) => seedCatalog(seeding, new Date()));
});

let fakes: FakeUpstash[] = [];
let clients: PrismaClient[] = [];

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", SESSION_SECRET);
  vi.stubEnv("ADMISSION_SECRET", ADMISSION_SECRET);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
  fakes = [];
  clients = [];
});

interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly fields: object;
  readonly message: string;
}

function recordingLogger() {
  const lines: LogLine[] = [];
  const logger: Logger = {
    info: (fields, message) => {
      lines.push({ level: "info", fields, message: message ?? "" });
    },
    warn: (fields, message) => {
      lines.push({ level: "warn", fields, message: message ?? "" });
    },
    error: (fields, message) => {
      lines.push({ level: "error", fields, message: message ?? "" });
    },
    child: () => logger,
  };
  return {
    logger,
    lines,
    /** The booking service's "metric failed" lines: which increment failed, and why. */
    metricFailures: () =>
      lines
        .filter((line) => line.message === "metric failed")
        .map(({ fields }) => {
          const err: unknown = Reflect.get(fields, "err");
          return {
            metric: Reflect.get(fields, "metric"),
            eventId: Reflect.get(fields, "eventId"),
            error: err instanceof Error ? err.message : String(err),
          };
        }),
  };
}

async function fakeUpstash(mode: "ok" | "error" | "silent" = "ok"): Promise<FakeUpstash> {
  const fake = await startFakeUpstash(mode);
  fakes.push(fake);
  return fake;
}

/** The app's context services over one Upstash endpoint (`undefined`: none configured). */
function app(upstashUrl: string | undefined) {
  const log = recordingLogger();
  const services = createContextServices({
    readEnv: () => ({
      ...(upstashUrl === undefined
        ? {}
        : { UPSTASH_REDIS_REST_URL: upstashUrl, UPSTASH_REDIS_REST_TOKEN: "fake-upstash-token" }),
      REDIS_URL: redis.url,
    }),
    logger: log.logger,
    queuePrefix: `${redis.prefix}${randomUUID()}:`,
  });
  return {
    log,
    services,
    /** The real context factory over a booking runtime and these services. */
    on: (runtime: LazyBookingRuntime) => createTRPCContextFactory(runtime, services),
  };
}

type ContextFactory = ReturnType<typeof createTRPCContextFactory>;

/** A booking runtime on the test database, as the app composes it; disconnected after the test. */
function runtime(timeouts: BookingTimeouts = DEFAULT_BOOKING_TIMEOUTS): LazyBookingRuntime {
  const booking = connectBooking(
    composeBooking({ DATABASE_URL: database.url, DATABASE_DRIVER: "pg" }, timeouts),
  );
  clients.push(booking.db);
  return { timeouts, db: () => booking.db };
}

/** A browser: its signed session cookie, plus every cookie a response sets. */
interface Browser {
  readonly sessionId: string;
  readonly cookies: Map<string, string>;
}

async function browser(): Promise<Browser> {
  const value = await issueSessionCookieValue(SESSION_SECRET);
  return { sessionId: value.split(".")[0] ?? "", cookies: new Map([["ta_session", value]]) };
}

/** One HTTP request's context, built by the factory from the browser's cookies. */
async function request<T>(
  factory: ContextFactory,
  from: Browser,
  call: (ctx: TRPCContext) => Promise<T>,
): Promise<T> {
  const cookie = [...from.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  const resHeaders = new Headers();
  const ctx = await factory({ req: new Request(API_URL, { headers: { cookie } }), resHeaders });
  try {
    return await call(ctx);
  } finally {
    for (const header of resHeaders.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      from.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

async function demoEventId(): Promise<string> {
  return (await db().event.findFirstOrThrow({ where: { demo: true } })).id;
}

/** A browser admitted to the demo event like a buyer is: join (its queue has closed), then status. */
async function admitted(factory: ContextFactory): Promise<Browser> {
  const buyer = await browser();
  const eventId = await demoEventId();
  await request(factory, buyer, (ctx) => createCaller(ctx).queue.join({ eventId }));
  const status = await request(factory, buyer, (ctx) =>
    createCaller(ctx).queue.status({ eventId }),
  );
  expect(status).toEqual({ status: "ADMITTED" });
  return buyer;
}

/** A live hold of the browser's session on one free demo seat, made without any metrics. */
async function heldBy(buyer: Browser) {
  const { eventId, seatIds } = await freeSeats(db(), 1);
  return createBookingService({
    db: db(),
    clock: { now: () => new Date() },
    newId: randomUUID,
  }).holdSeats(
    {
      sessionId: buyer.sessionId,
      buyerKey: buyerKey({ kind: "guest", sessionId: buyer.sessionId }),
    },
    eventId,
    seatIds,
  );
}

/** placeOrder through the router, its first transaction attempt failed by a real 40001. */
async function orderRetriedOnce(
  factory: ContextFactory,
  buyer: Browser,
  holdId: string,
  around: (ctx: TRPCContext) => TRPCContext = (ctx) => ctx,
) {
  const idempotencyKey = randomUUID();
  return withTrigger(
    db(),
    {
      table: "orders",
      timing: "BEFORE INSERT",
      when: `NEW."idempotencyKey" = '${idempotencyKey}'`,
      body: `IF $calls = 1 THEN
               RAISE EXCEPTION 'test-induced serialization failure' USING ERRCODE = '40001';
             END IF;`,
    },
    async (trigger) => {
      const order = await request(factory, buyer, (ctx) =>
        createCaller(around(ctx)).booking.placeOrder({
          holdId,
          contact: CONTACT,
          idempotencyKey,
        }),
      );
      return { order, attempts: await trigger.calls() };
    },
  );
}

const hincrby = (eventId: string, metric: string) => [
  "HINCRBY",
  `booking:metrics:${eventId}`,
  metric,
  1,
];

describe("booking metrics wiring", () => {
  test("holdSeats and placeOrder count through the one metrics instance the context resolves", async () => {
    const upstash = await fakeUpstash();
    const { services, on } = app(upstash.url);
    const factory = on(runtime());
    const buyer = await admitted(factory);
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const resolved: BookingMetrics[] = [];
    const recordingResolution = (ctx: TRPCContext): TRPCContext => ({
      ...ctx,
      metrics: () => {
        const metrics = ctx.metrics();
        resolved.push(metrics);
        return metrics;
      },
    });

    const hold = await request(factory, buyer, (ctx) =>
      createCaller(recordingResolution(ctx)).booking.holdSeats({ eventId, seatIds }),
    );
    await orderRetriedOnce(factory, buyer, hold.id, recordingResolution);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toBe(services.metrics());
    expect(resolved[1]).toBe(services.metrics());
    await expect
      .poll(() => upstash.commands)
      .toEqual([hincrby(eventId, "hold_ok"), hincrby(eventId, "deadlock_retry")]);
  });

  test("procedures that do not book never resolve the metrics", async () => {
    const upstash = await fakeUpstash();
    const factory = app(upstash.url).on(runtime());
    const buyer = await browser();
    const hold = await heldBy(buyer);
    const resolve = vi.fn((): BookingMetrics => {
      throw new Error("a procedure that does not book resolved the metrics");
    });
    const caller = (ctx: TRPCContext) => createCaller({ ...ctx, metrics: resolve });

    await request(factory, buyer, (ctx) => caller(ctx).booking.getHold({ holdId: hold.id }));
    await request(factory, buyer, (ctx) =>
      caller(ctx).booking.activeHold({ eventId: hold.eventId }),
    );
    await request(factory, buyer, (ctx) => caller(ctx).booking.releaseHold({ holdId: hold.id }));
    const missing = await failureOf(
      request(factory, buyer, (ctx) => caller(ctx).booking.getOrder({ orderId: randomUUID() })),
    );

    expect(missing).toMatchObject({ code: "NOT_FOUND" });
    expect(resolve).not.toHaveBeenCalled();
    expect(upstash.commands).toEqual([]);
  });

  test("without an Upstash configuration a hold and an order still succeed, and the boundary says why once", async () => {
    const { log, on } = app(undefined);
    const factory = on(runtime());
    const buyer = await admitted(factory);
    const { eventId, seatIds } = await freeSeats(db(), 1);

    const hold = await request(factory, buyer, (ctx) =>
      createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
    );
    const { order } = await orderRetriedOnce(factory, buyer, hold.id);

    expect(hold.status).toBe("HELD");
    expect(order.status).toBe("PENDING_PAYMENT");
    const configErrors = log.lines.filter(
      (line) => line.message === "metrics configuration is invalid",
    );
    expect(configErrors).toHaveLength(1);
    expect(String(Reflect.get(configErrors[0]?.fields ?? {}, "err"))).toMatch(
      /UPSTASH_REDIS_REST_URL/,
    );
  });
});

describe("holdSeats counts reach Upstash", () => {
  test("a successful hold sends HINCRBY booking:metrics:<eventId> hold_ok 1", async () => {
    const upstash = await fakeUpstash();
    const factory = app(upstash.url).on(runtime());
    const buyer = await admitted(factory);
    const { eventId, seatIds } = await freeSeats(db(), 1);

    const hold = await request(factory, buyer, (ctx) =>
      createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
    );

    expect(hold).toMatchObject({ eventId, seatIds, status: "HELD" });
    await expect.poll(() => upstash.commands).toEqual([hincrby(eventId, "hold_ok")]);
  });

  test("a hold that exhausts its lock-timeout retries is BOOKING_BUSY and sends deadlock_retry three times, then booking_busy once", async () => {
    const upstash = await fakeUpstash();
    const { on } = app(upstash.url);
    const buyer = await admitted(on(runtime()));
    const timeouts = { lockTimeoutMs: 200, statementTimeoutMs: 5_000, retries: 3 };
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const blocker = await block(db(), rowLock("seats", seatIds), { what: "the seat's row lock" });
    let error: unknown;
    try {
      error = await failureOf(
        request(on(runtime(timeouts)), buyer, (ctx) =>
          createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
        ),
      );
    } finally {
      await blocker.release();
    }

    expect(error).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringMatching(/^BOOKING_BUSY/),
    });
    await expect
      .poll(() => upstash.commands)
      .toEqual([
        hincrby(eventId, "deadlock_retry"),
        hincrby(eventId, "deadlock_retry"),
        hincrby(eventId, "deadlock_retry"),
        hincrby(eventId, "booking_busy"),
      ]);
  }, 20_000);

  test("a hold refused on a saturated pool sends booking_busy once", async () => {
    const upstash = await fakeUpstash();
    const { on } = app(upstash.url);
    const buyer = await admitted(on(runtime()));
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const tight = open({ poolMax: 1, acquireTimeoutMs: 300 });
    // occupy opens the pool's only connection itself, so the hold only ever meets a full pool.
    const occupation = await occupy(tight);
    let error: unknown;
    try {
      error = await failureOf(
        request(on({ timeouts: DEFAULT_BOOKING_TIMEOUTS, db: () => tight }), buyer, (ctx) =>
          createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
        ),
      );
    } finally {
      await occupation.release();
    }

    expect(error).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect.poll(() => upstash.commands).toEqual([hincrby(eventId, "booking_busy")]);
  });
});

describe("placeOrder counts reach Upstash", () => {
  test("an order retried once after a real 40001 succeeds and sends deadlock_retry once", async () => {
    const upstash = await fakeUpstash();
    const factory = app(upstash.url).on(runtime());
    const buyer = await browser();
    const hold = await heldBy(buyer);

    const { order, attempts } = await orderRetriedOnce(factory, buyer, hold.id);

    expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT" });
    expect(attempts).toBe(2);
    await expect.poll(() => upstash.commands).toEqual([hincrby(hold.eventId, "deadlock_retry")]);
  });

  test("an order refused on a saturated pool before its event is known sends booking_busy to the unknown-event key", async () => {
    const upstash = await fakeUpstash();
    const { on } = app(upstash.url);
    const buyer = await browser();
    const hold = await heldBy(buyer);
    const tight = open({ poolMax: 1, acquireTimeoutMs: 300 });
    const occupation = await occupy(tight);
    let error: unknown;
    try {
      error = await failureOf(
        request(on({ timeouts: DEFAULT_BOOKING_TIMEOUTS, db: () => tight }), buyer, (ctx) =>
          createCaller(ctx).booking.placeOrder({
            holdId: hold.id,
            contact: CONTACT,
            idempotencyKey: randomUUID(),
          }),
        ),
      );
    } finally {
      await occupation.release();
    }

    expect(error).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringMatching(/^BOOKING_BUSY/),
    });
    await expect.poll(() => upstash.commands).toEqual([hincrby("unknown", "booking_busy")]);
  });
});

describe("booking metrics are best effort", () => {
  /** A hold through the router, then its order retried once after a 40001: two increments. */
  async function holdAndOrder(factory: ContextFactory) {
    const buyer = await admitted(factory);
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const hold = await request(factory, buyer, (ctx) =>
      createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
    );
    const { order } = await orderRetriedOnce(factory, buyer, hold.id);
    return { eventId, hold, order };
  }

  const endpoints = {
    "returns 500": async () => {
      const upstash = await fakeUpstash("error");
      return { url: upstash.url, commands: () => upstash.commands };
    },
    "refuses the connection": async () => {
      const url = await refusedUrl();
      return { url, commands: () => undefined };
    },
  };

  test.each(Object.keys(endpoints) as (keyof typeof endpoints)[])(
    "when Upstash %s, holdSeats and placeOrder succeed and each failed increment is logged once with its metric",
    async (endpoint) => {
      const upstash = await endpoints[endpoint]();
      const { log, on } = app(upstash.url);

      const { eventId, hold, order } = await holdAndOrder(on(runtime()));

      expect(hold.status).toBe("HELD");
      expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT" });
      await expect
        .poll(() => log.metricFailures().map((failure) => failure.metric))
        .toEqual(["hold_ok", "deadlock_retry"]);
      for (const failure of log.metricFailures()) {
        expect(failure).toMatchObject({ eventId, error: expect.stringMatching(/HINCRBY/) });
      }
      const commands = upstash.commands();
      if (commands !== undefined) {
        expect(commands).toEqual([hincrby(eventId, "hold_ok"), hincrby(eventId, "deadlock_retry")]);
      }
    },
  );

  test("when Upstash never answers, holdSeats and placeOrder return before their increments time out, and each is logged once", async () => {
    const upstash = await fakeUpstash("silent");
    const { log, on } = app(upstash.url);
    const factory = on(runtime());
    const buyer = await admitted(factory);
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const failed = (metric: string) =>
      log.metricFailures().filter((failure) => failure.metric === metric);

    const hold = await request(factory, buyer, (ctx) =>
      createCaller(ctx).booking.holdSeats({ eventId, seatIds }),
    );
    // A booking that waited on its increment would come back only after the request timed out.
    expect(failed("hold_ok")).toEqual([]);
    const { order } = await orderRetriedOnce(factory, buyer, hold.id);
    expect(failed("deadlock_retry")).toEqual([]);

    expect(hold.status).toBe("HELD");
    expect(order.status).toBe("PENDING_PAYMENT");
    await expect
      .poll(() => log.metricFailures().map((failure) => failure.metric), { timeout: 10_000 })
      .toEqual(["hold_ok", "deadlock_retry"]);
    for (const failure of log.metricFailures()) {
      expect(failure).toMatchObject({
        eventId,
        error: expect.stringMatching(/HINCRBY failed: request did not complete/),
      });
    }
    expect(upstash.commands).toEqual([
      hincrby(eventId, "hold_ok"),
      hincrby(eventId, "deadlock_retry"),
    ]);
  });
});
