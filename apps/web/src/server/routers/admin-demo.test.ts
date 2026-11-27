import { randomUUID } from "node:crypto";
import {
  createRedisBookingMetrics,
  createRedisBookingMetricsReader,
  createRedisBookingMetricsReset,
  DEFAULT_BOOKING_TIMEOUTS,
} from "@ticketarena/booking";
import { freeSeats, NOW, testClients, withClient } from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import { seedCatalog } from "@ticketarena/db/seed";
import { setupTestDatabase, setupTestRedis, setupTestUpstash } from "@ticketarena/test-infra";
import { createRedisQueueStore } from "@ticketarena/waiting-room";
import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createAdminRateLimiter } from "../rate-limiter";
import { createBrowserCookies } from "../testing/browser-cookies";
import type { TRPCContext } from "../trpc";
import { createUpstashMetricsClient } from "../upstash-metrics";
import { createCaller } from "./_app";

const database = setupTestDatabase();
const redis = setupTestRedis();
const upstash = setupTestUpstash();
const redisClient = createClient({ url: redis.url });
const upstashClient = createUpstashMetricsClient({ url: upstash.url, token: upstash.token });
const { db } = testClients(database);

beforeAll(async () => {
  await redisClient.connect();
  await withClient(database, (seeding) => seedCatalog(seeding, NOW));
});

afterAll(async () => {
  redisClient.destroy();
});

const queueStore = () => createRedisQueueStore(redisClient, { prefix: redis.prefix });
// The race's 100 counter increments go to node-redis, not the shared Upstash HTTP proxy, so this
// file's burst cannot starve other files' Upstash calls; the commands and key layout are the same.
const metricsPrefix = `${redis.prefix}metrics:`;

// A fresh limiter namespace per test: each test starts with both actions allowed once.
let limiterPrefix = "";
function freshLimiter(): void {
  limiterPrefix = `${upstash.prefix}${randomUUID()}:`;
}
beforeEach(freshLimiter);

const browser = createBrowserCookies("d".repeat(32));

function caller(overrides: Partial<TRPCContext> = {}) {
  const principal = overrides.principal ?? guest();
  const now = overrides.now ?? (() => NOW);
  return createCaller({
    now,
    principal,
    isAdmin: true,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger: silentLogger,
    metrics: () => createRedisBookingMetrics(redisClient, metricsPrefix),
    metricsReader: () => createRedisBookingMetricsReader(redisClient, metricsPrefix),
    metricsReset: () => createRedisBookingMetricsReset(redisClient, metricsPrefix),
    workerHealth: () => {
      throw new Error("worker health is not read here");
    },
    rateLimiter: () => createAdminRateLimiter(upstashClient, limiterPrefix),
    queueStore: async () => queueStore(),
    random: { next: () => 0 },
    admissionTokens: browser.admissionTokens(principal.sessionId, now()),
    ...overrides,
  });
}

const guest = (): Principal => ({ kind: "guest", sessionId: randomUUID().replaceAll("-", "") });

async function events() {
  const demo = await db().event.findFirstOrThrow({ where: { demo: true } });
  const others = await db().event.findMany({ where: { demo: false } });
  return { demo, others };
}

/** Every seat, hold and order of the non-demo events, to prove the demo actions left them alone. */
async function otherEventsState(otherIds: readonly string[]) {
  const [seats, holds, orders] = await Promise.all([
    db().seat.findMany({ where: { eventId: { in: [...otherIds] } }, orderBy: { id: "asc" } }),
    db().hold.findMany({ where: { eventId: { in: [...otherIds] } }, orderBy: { id: "asc" } }),
    db().order.findMany({
      where: { hold: { eventId: { in: [...otherIds] } } },
      orderBy: { id: "asc" },
    }),
  ]);
  return { seats, holds, orders };
}

describe("admin.runRace", () => {
  test("AT-45: 100 synthetic buyers race for one demo seat and exactly one wins", async () => {
    const { demo } = await events();
    let tick = 0;
    // Each clock read is 1 ms later, so the duration is measured on the injected clock.
    const now = () => new Date(NOW.getTime() + tick++);

    const race = await caller({ now }).admin.runRace();

    expect(race.eventId).toBe(demo.id);
    expect(race.buyers).toBe(100);
    expect(race.successes).toBe(1);
    expect(race.seatUnavailable + race.bookingBusy).toBe(99);
    expect(race.otherErrors).toBe(0);
    expect(race.durationMs).toBeGreaterThan(0);
    const seat = await db().seat.findUniqueOrThrow({ where: { id: race.seatId } });
    expect(seat).toMatchObject({ eventId: demo.id, status: "HELD", holdId: race.winner?.holdId });
    // The winner's seat.held event is the race's entry in the outbox, which the live feed reads.
    const held = await db().outboxEvent.findMany({
      where: { eventType: "seat.held", aggregateId: race.winner?.holdId ?? "" },
    });
    expect(held).toHaveLength(1);
    expect(held[0]?.payload).toMatchObject({ correlationId: race.winner?.correlationId });
    expect(await db().hold.count({ where: { seats: { some: { id: race.seatId } } } })).toBe(1);
  });
});

describe("admin.resetDemo", () => {
  test("frees the demo event's seats, deletes unordered holds and clears its Redis keys", async () => {
    const { demo, others } = await events();
    const other = others[0];
    if (other === undefined) {
      throw new Error("the seed has no non-demo event");
    }
    await caller().admin.runRace();
    const counters = createRedisBookingMetrics(redisClient, metricsPrefix);
    await counters.increment("hold_ok", demo.id);
    await counters.increment("hold_ok", other.id);
    await queueStore().join(demo.id, "q1", { kind: "SEQUENCE" }, NOW);
    await queueStore().join(other.id, "q1", { kind: "SEQUENCE" }, NOW);

    const reset = await caller().admin.resetDemo();

    expect(reset).toMatchObject({ eventId: demo.id, ordersKept: 0 });
    expect(reset.holdsDeleted).toBeGreaterThan(0);
    expect(await db().hold.count({ where: { eventId: demo.id } })).toBe(0);
    expect(
      await db().seat.count({ where: { eventId: demo.id, status: { not: "AVAILABLE" } } }),
    ).toBe(0);
    const reader = createRedisBookingMetricsReader(redisClient, metricsPrefix);
    expect((await reader.read(demo.id)).hold_ok).toBe(0);
    expect((await reader.read(other.id)).hold_ok).toBe(1);
    expect(await queueStore().counts(demo.id)).toEqual({ queued: 0, active: 0 });
    expect(await queueStore().counts(other.id)).toEqual({ queued: 1, active: 0 });
  });

  test("a demo order awaiting payment refuses the reset with PRECONDITION_FAILED", async () => {
    const { demo } = await events();
    const buyer = guest();
    const [seatId] = (await freeSeats(db(), 1, { eventId: demo.id })).seatIds;
    await caller({ principal: buyer }).queue.join({ eventId: demo.id });
    await caller({ principal: buyer }).queue.status({ eventId: demo.id });
    const hold = await caller({ principal: buyer }).booking.holdSeats({
      eventId: demo.id,
      seatIds: [seatId ?? ""],
    });
    const order = await caller({ principal: buyer }).booking.placeOrder({
      holdId: hold.id,
      contact: { email: "buyer@example.com" },
      idempotencyKey: randomUUID(),
    });

    await expect(caller().admin.resetDemo()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("PENDING_PAYMENT"),
    });
    expect(await db().order.count({ where: { id: order.id } })).toBe(1);

    await db().order.update({ where: { id: order.id }, data: { status: "EXPIRED" } });
    freshLimiter();
    await expect(caller().admin.resetDemo()).resolves.toMatchObject({ ordersKept: 1 });
    expect(await db().order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: "EXPIRED",
    });
  });
});

describe("AT-44: race and reset only touch the demo event and are rate-limited", () => {
  test("neither action touches a non-demo event's seats, holds or orders", async () => {
    const { others } = await events();
    const otherIds = others.map((event) => event.id);
    const other = others[0];
    const [seat] = await db().seat.findMany({ where: { eventId: other?.id ?? "" }, take: 1 });
    // Non-demo events are upcoming at NOW, so the hold is made at the event's on-sale.
    const onSaleAt = other?.onSaleAt ?? NOW;
    // Admitted as when its queue has closed; the admission is still valid at the on-sale.
    const buyer = guest();
    const closed = other?.queueClosesAt ?? NOW;
    await caller({ principal: buyer, now: () => closed }).queue.join({ eventId: other?.id ?? "" });
    await caller({ principal: buyer, now: () => closed }).queue.status({
      eventId: other?.id ?? "",
    });
    await caller({ principal: buyer, now: () => onSaleAt }).booking.holdSeats({
      eventId: other?.id ?? "",
      seatIds: [seat?.id ?? ""],
    });
    const before = await otherEventsState(otherIds);

    await caller().admin.runRace();
    await caller().admin.resetDemo();

    expect(await otherEventsState(otherIds)).toEqual(before);
  });

  test("a second race or reset within 10 s is TOO_MANY_REQUESTS and does nothing", async () => {
    const { demo } = await events();
    await caller().admin.runRace();
    await caller().admin.resetDemo();
    const holdsBefore = await db().hold.count({ where: { eventId: demo.id } });

    await expect(caller().admin.runRace()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringMatching(/1 per 10 s.*retry in \d+ s/),
    });
    expect(await db().hold.count({ where: { eventId: demo.id } })).toBe(holdsBefore);
    await expect(caller().admin.resetDemo()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  test("without the admin cookie both actions are UNAUTHORIZED", async () => {
    await expect(caller({ isAdmin: false }).admin.runRace()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller({ isAdmin: false }).admin.resetDemo()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
