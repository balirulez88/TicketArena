import { randomUUID } from "node:crypto";
import { createRedisBookingMetrics, createRedisBookingMetricsReader } from "@ticketarena/booking";
import { silentLogger } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase, setupTestRedis, setupTestUpstash } from "@ticketarena/test-infra";
import { createRedisQueueStore } from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { issueAdminCookieValue } from "../identity/admin-session";
import { issueSessionCookieValue, type Principal } from "../identity/identity";
import { createBrowserCookies } from "../testing/browser-cookies";
import { createTRPCContext, type TRPCContext } from "../trpc";
import { createUpstashMetricsClient } from "../upstash-metrics";
import { createCaller } from "./_app";

const SECRET = "s".repeat(32);

describe("AT-44 (auth part): admin procedures reject a missing or invalid admin cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Built by the real boundary, so the cookie is checked exactly as for an HTTP request.
  async function contextWithCookie(cookie?: string): Promise<TRPCContext> {
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", "postgresql://unused@127.0.0.1:1/unused");
    return createTRPCContext({
      req: new Request("https://ticketarena.example/api/trpc", {
        headers: cookie ? { cookie } : {},
      }),
      resHeaders: new Headers(),
    });
  }

  test("no admin cookie is UNAUTHORIZED", async () => {
    const ctx = await contextWithCookie();

    await expect(createCaller(ctx).admin.snapshot()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  test("an admin cookie signed with another secret is UNAUTHORIZED", async () => {
    const forged = await issueAdminCookieValue("x".repeat(32), new Date());
    const ctx = await contextWithCookie(`ta_admin=${forged}`);

    await expect(createCaller(ctx).admin.snapshot()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  test("an expired admin cookie is UNAUTHORIZED", async () => {
    const expired = await issueAdminCookieValue(SECRET, new Date("2020-01-01T00:00:00.000Z"));
    const ctx = await contextWithCookie(`ta_admin=${expired}`);

    await expect(createCaller(ctx).admin.snapshot()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  test("a guest session cookie value under the admin name is UNAUTHORIZED", async () => {
    const guest = await issueSessionCookieValue(SECRET);
    const ctx = await contextWithCookie(`ta_session=${guest}; ta_admin=${guest}`);

    await expect(createCaller(ctx).admin.snapshot()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  test("a valid admin cookie marks the request as admin", async () => {
    const valid = await issueAdminCookieValue(SECRET, new Date());

    expect((await contextWithCookie(`ta_admin=${valid}`)).isAdmin).toBe(true);
  });
});

describe("admin.snapshot", () => {
  const database = setupTestDatabase();
  const redis = setupTestRedis();
  const upstash = setupTestUpstash();
  const redisClient = createClient({ url: redis.url });
  const upstashClient = createUpstashMetricsClient({ url: upstash.url, token: upstash.token });
  let prisma: PrismaClient | undefined;

  function db(): PrismaClient {
    prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
    return prisma;
  }

  const NOW = new Date("2027-03-01T12:00:00.000Z");

  beforeAll(async () => {
    await redisClient.connect();
    await seedCatalog(db(), NOW);
  });

  afterAll(async () => {
    redisClient.destroy();
    await prisma?.$disconnect();
  });

  const queueStore = () => createRedisQueueStore(redisClient, { prefix: redis.prefix });

  const browser = createBrowserCookies("d".repeat(32));

  function caller(principal: Principal, overrides: Partial<TRPCContext> = {}) {
    return createCaller({
      now: () => NOW,
      principal,
      isAdmin: true,
      db: db(),
      logger: silentLogger,
      // Booking records counters fire-and-forget; the test writes them itself, awaited.
      metrics: () => ({ increment: async () => undefined }),
      metricsReader: () => createRedisBookingMetricsReader(upstashClient, upstash.prefix),
      metricsReset: () => {
        throw new Error("metrics are not reset here");
      },
      rateLimiter: () => {
        throw new Error("nothing is rate-limited here");
      },
      queueStore: async () => queueStore(),
      random: { next: () => 0 },
      admissionTokens: browser.admissionTokens(principal.sessionId, NOW),
      ...overrides,
    });
  }

  const guest = (): Principal => ({ kind: "guest", sessionId: randomUUID().replaceAll("-", "") });

  test("reports seats and orders by status, pending payments, queue figures and booking metrics", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const seats = await db().seat.findMany({
      where: { eventId: event.id },
      orderBy: { id: "asc" },
      take: 3,
    });
    const seatIds = seats.map((seat) => seat.id);
    const total = await db().seat.count({ where: { eventId: event.id } });
    // Two seats held by one buyer, one seat in checkout under a placed order. Holding takes an
    // admission (the demo queue has closed, so join admits at once); placing the order frees the
    // buyer's slot, so only the first holder stays an active shopper.
    const holder = guest();
    const buyer = guest();
    for (const principal of [holder, buyer]) {
      await caller(principal).queue.join({ eventId: event.id });
      await caller(principal).queue.status({ eventId: event.id });
    }
    await caller(holder).booking.holdSeats({ eventId: event.id, seatIds: seatIds.slice(0, 2) });
    const hold = await caller(buyer).booking.holdSeats({
      eventId: event.id,
      seatIds: seatIds.slice(2, 3),
    });
    await caller(buyer).booking.placeOrder({
      holdId: hold.id,
      contact: { email: "buyer@example.com" },
      idempotencyKey: randomUUID(),
    });
    const counters = createRedisBookingMetrics(upstashClient, upstash.prefix);
    await counters.increment("hold_ok", event.id);
    await counters.increment("hold_ok", event.id);
    await counters.increment("race_lost", event.id);
    // Three in the queue, one admitted: two queued, and with the holder two active shoppers.
    for (const member of ["q1", "q2", "q3"]) {
      await queueStore().join(event.id, member, { kind: "SEQUENCE" });
    }
    await queueStore().admit(event.id, {
      now: NOW,
      admitRate: 1,
      maxActive: 10,
      admissionTtlMs: 60_000,
      jtis: [randomUUID()],
    });

    const snapshot = await caller(guest()).admin.snapshot();

    expect(snapshot.takenAt).toEqual(NOW);
    expect(snapshot.orders).toEqual({ PENDING_PAYMENT: 1, CONFIRMED: 0, CANCELLED: 0, EXPIRED: 0 });
    expect(snapshot.pendingPayments).toBe(1);
    const demo = snapshot.events.find((candidate) => candidate.eventId === event.id);
    expect(demo).toEqual({
      eventId: event.id,
      name: event.name,
      demo: true,
      seats: { AVAILABLE: total - 3, HELD: 2, IN_CHECKOUT: 1, SOLD: 0 },
      queueLength: 2,
      activeShoppers: 2,
      metrics: {
        hold_ok: 2,
        seat_unavailable: 0,
        race_lost: 1,
        booking_busy: 0,
        limit_exceeded: 0,
      },
    });
    const others = snapshot.events.filter((candidate) => candidate.eventId !== event.id);
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(other).toMatchObject({
        seats: { HELD: 0, IN_CHECKOUT: 0, SOLD: 0 },
        queueLength: 0,
        activeShoppers: 0,
      });
    }
  });

  test("lists every event even when metrics are unavailable, reporting them as null", async () => {
    const snapshot = await caller(guest(), {
      metricsReader: () => {
        throw new Error("Invalid metrics environment: UPSTASH_REDIS_REST_URL");
      },
    }).admin.snapshot();

    expect(snapshot.events.length).toBe(await db().event.count());
    expect(snapshot.events.every((event) => event.metrics === null)).toBe(true);
  });
});
