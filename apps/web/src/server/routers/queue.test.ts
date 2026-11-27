import { randomUUID } from "node:crypto";
import { DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import { freeSeats, NOW, testClients, withClient } from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import { seedCatalog } from "@ticketarena/db/seed";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import {
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
  type Random,
} from "@ticketarena/waiting-room";
import { jwtVerify } from "jose";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createBrowserCookies } from "../testing/browser-cookies";
import { createCaller } from "./_app";

const database = setupTestDatabase();
const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });
const { db } = testClients(database);

const SEEDED_AT = NOW;

beforeAll(async () => {
  await redisClient.connect();
  await withClient(database, (seeding) => seedCatalog(seeding, SEEDED_AT));
});

afterAll(async () => {
  redisClient.destroy();
});

// One queue namespace per test, so the seeded event can be reused without sharing positions.
let queuePrefix = "";

function guest(): Principal {
  return { kind: "guest", sessionId: randomUUID().replaceAll("-", "") };
}

const ADMISSION_SECRET = "q".repeat(32);

const browser = createBrowserCookies(ADMISSION_SECRET);
const jarOf = (principal: Principal) => browser.jarOf(principal.sessionId);
const admissionTokensFor = (principal: Principal, now: Date) =>
  browser.admissionTokens(principal.sessionId, now);

function caller(principal: Principal, now: Date, random: Random = { next: () => 0.5 }) {
  return createCaller({
    now: () => now,
    principal,
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger: silentLogger,
    metrics: () => ({ increment: async () => undefined }),
    metricsReader: () => {
      throw new Error("metrics are not read here");
    },
    metricsReset: () => {
      throw new Error("metrics are not reset here");
    },
    workerHealth: () => {
      throw new Error("worker health is not read here");
    },
    rateLimiter: () => {
      throw new Error("nothing is rate-limited here");
    },
    queueStore: async () =>
      createRedisQueueStore(redisClient, { prefix: `${redis.prefix}${queuePrefix}` }),
    random,
    admissionTokens: admissionTokensFor(principal, now),
  });
}

async function scheduledEvent() {
  queuePrefix = `${randomUUID()}:`;
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  return {
    eventId: event.id,
    beforeOnSale: new Date(event.onSaleAt.getTime() - 60_000),
    afterOnSale: new Date(event.onSaleAt.getTime() + 60_000),
    queueOpensAt: event.queueOpensAt,
    beforeQueueOpens: new Date(event.queueOpensAt.getTime() - 1),
    afterQueueCloses: new Date(event.queueClosesAt.getTime() + 60_000),
  };
}

describe("queue.join", () => {
  test("in the queue window returns the position and an ETA", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    await caller(guest(), afterOnSale).queue.join({ eventId });

    const result = await caller(guest(), afterOnSale).queue.join({ eventId });

    expect(result).toEqual({ status: "QUEUED", position: 2, etaSeconds: expect.any(Number) });
  });

  test("orders pre-queue joins by the injected randomness ahead of later joins", async () => {
    const { eventId, beforeOnSale, afterOnSale } = await scheduledEvent();
    const [late, high, low] = [guest(), guest(), guest()];
    await caller(late, afterOnSale).queue.join({ eventId });
    await caller(high, beforeOnSale, { next: () => 0.8 }).queue.join({ eventId });
    await caller(low, beforeOnSale, { next: () => 0.2 }).queue.join({ eventId });

    const statuses = await Promise.all(
      [low, high, late].map((principal) =>
        caller(principal, afterOnSale).queue.status({ eventId }),
      ),
    );

    expect(statuses).toMatchObject([{ position: 1 }, { position: 2 }, { position: 3 }]);
  });

  test("a re-join keeps the position", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    await caller(alice, afterOnSale).queue.join({ eventId });
    await caller(guest(), afterOnSale).queue.join({ eventId });

    expect(await caller(alice, afterOnSale).queue.join({ eventId })).toMatchObject({
      position: 1,
    });
  });

  test("before the queue opens returns NOT_OPEN with the opening time and queues nothing", async () => {
    const { eventId, queueOpensAt, beforeQueueOpens } = await scheduledEvent();
    const early = guest();

    expect(await caller(early, beforeQueueOpens).queue.join({ eventId })).toEqual({
      status: "NOT_OPEN",
      queueOpensAt,
    });
    expect(await caller(early, beforeQueueOpens).queue.status({ eventId })).toEqual({
      status: "NOT_QUEUED",
    });
  });

  test("after the queue closes reports immediate admission eligibility", async () => {
    const { eventId, afterQueueCloses } = await scheduledEvent();

    expect(await caller(guest(), afterQueueCloses).queue.join({ eventId })).toEqual({
      status: "ADMISSIBLE",
    });
  });

  test("an unknown event is NOT_FOUND", async () => {
    await expect(
      caller(guest(), SEEDED_AT).queue.join({ eventId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a malformed event id is BAD_REQUEST naming eventId", async () => {
    await expect(caller(guest(), SEEDED_AT).queue.join({ eventId: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("eventId"),
    });
  });
});

describe("queue.status and queue.leave", () => {
  test("status reports the position; leave removes the caller and moves the next buyer up", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const [alice, bob] = [guest(), guest()];
    await caller(alice, afterOnSale).queue.join({ eventId });
    await caller(bob, afterOnSale).queue.join({ eventId });

    expect(await caller(bob, afterOnSale).queue.status({ eventId })).toEqual({
      status: "QUEUED",
      position: 2,
      etaSeconds: expect.any(Number),
    });

    expect(await caller(alice, afterOnSale).queue.leave({ eventId })).toEqual({ left: true });

    expect(await caller(alice, afterOnSale).queue.status({ eventId })).toEqual({
      status: "NOT_QUEUED",
    });
    expect(await caller(bob, afterOnSale).queue.status({ eventId })).toMatchObject({
      position: 1,
    });
  });

  test("leave rejects a malformed event id naming eventId", async () => {
    await expect(caller(guest(), SEEDED_AT).queue.leave({ eventId: "x" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("eventId"),
    });
  });
});

describe("admission slots", () => {
  // The worker's ticker and reaper run the same service; here it is driven at the test's clock.
  function queueServiceAt(now: Date) {
    return createQueueService({
      store: createRedisQueueStore(redisClient, { prefix: `${redis.prefix}${queuePrefix}` }),
      policy: createScheduleAdmissionPolicy(),
      clock: { now: () => now },
      random: { next: () => 0.5 },
      newId: randomUUID,
      admitRatePerSecond: 10,
    });
  }

  /** Joins, is admitted by a tick, and (with `poll`) receives the admission token. */
  async function admitted(eventId: string, now: Date, principal: Principal, poll = true) {
    await caller(principal, now).queue.join({ eventId });
    const ticker = queueServiceAt(now);
    const event = await db().event.findUniqueOrThrow({ where: { id: eventId } });
    const [admission] = await ticker.admitTick(event, { admitRate: 1, maxActive: 10 });
    if (poll) {
      await caller(principal, now).queue.status({ eventId });
    }
    return { ticker, jti: admission?.jti ?? "" };
  }

  function later(now: Date, ms: number) {
    return new Date(now.getTime() + ms);
  }

  test("the admitted session's next status poll mints the admission token into ta_adm_<eventId>", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { jti } = await admitted(eventId, afterOnSale, alice, false);
    expect(jarOf(alice).has(`ta_adm_${eventId}`)).toBe(false);

    await caller(alice, later(afterOnSale, 5_000)).queue.status({ eventId });

    const token = jarOf(alice).get(`ta_adm_${eventId}`) ?? "";
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(ADMISSION_SECRET),
      { currentDate: afterOnSale },
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload).toMatchObject({
      sub: alice.sessionId,
      eid: eventId,
      jti,
      // admittedAt + 30 min, not the poll time.
      exp: Math.floor(later(afterOnSale, 30 * 60_000).getTime() / 1000),
    });
  });

  test("a queued session's status poll mints no token", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    await caller(alice, afterOnSale).queue.join({ eventId });

    await caller(alice, afterOnSale).queue.status({ eventId });

    expect(jarOf(alice).size).toBe(0);
  });

  test("an admitted session's status poll reports ADMITTED and heartbeats its slot", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { ticker } = await admitted(eventId, afterOnSale, alice);

    expect(await caller(alice, later(afterOnSale, 60_000)).queue.status({ eventId })).toEqual({
      status: "ADMITTED",
    });

    // Last seen at +60 s, so a reap at +120 s (cutoff +30 s) keeps the slot.
    expect(await queueServiceAt(later(afterOnSale, 120_000)).reap(eventId)).toEqual([]);
    expect(await ticker.counts(eventId)).toEqual({ queued: 0, active: 1 });
  });

  test("join by an admitted session returns ADMITTED and keeps its admission", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { ticker, jti } = await admitted(eventId, afterOnSale, alice);

    expect(await caller(alice, afterOnSale).queue.join({ eventId })).toEqual({
      status: "ADMITTED",
    });

    expect(await ticker.isAdmitted(eventId, jti)).toBe(true);
    expect(await ticker.counts(eventId)).toEqual({ queued: 0, active: 1 });
  });

  test("after leaving, an admitted session joins again and is queued", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    await admitted(eventId, afterOnSale, alice);
    await caller(alice, afterOnSale).queue.leave({ eventId });

    expect(await caller(alice, afterOnSale).queue.join({ eventId })).toMatchObject({
      status: "QUEUED",
      position: 1,
    });
  });

  test("AT-39: leave frees the slot and revokes the admission", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { ticker, jti } = await admitted(eventId, afterOnSale, alice);

    expect(await caller(alice, afterOnSale).queue.leave({ eventId })).toEqual({ left: true });

    expect(await ticker.isAdmitted(eventId, jti)).toBe(false);
    expect(await ticker.counts(eventId)).toEqual({ queued: 0, active: 0 });
  });

  test("an admitted call (holdSeats) heartbeats the slot", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    await admitted(eventId, afterOnSale, alice);
    const { seatIds } = await freeSeats(db(), 1, { eventId });
    const seat = { id: seatIds[0] ?? "" };

    await caller(alice, later(afterOnSale, 60_000)).booking.holdSeats({
      eventId,
      seatIds: [seat.id],
    });

    expect(await queueServiceAt(later(afterOnSale, 120_000)).reap(eventId)).toEqual([]);
  });

  test("AT-39: placing an order frees the slot and revokes the admission; the order stands", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { ticker, jti } = await admitted(eventId, afterOnSale, alice);
    const { seatIds } = await freeSeats(db(), 1, { eventId });
    const seat = { id: seatIds[0] ?? "" };
    const hold = await caller(alice, afterOnSale).booking.holdSeats({
      eventId,
      seatIds: [seat.id],
    });

    const order = await caller(alice, afterOnSale).booking.placeOrder({
      holdId: hold.id,
      contact: { email: "alice@example.com" },
      idempotencyKey: randomUUID(),
    });

    expect(order.status).toBe("PENDING_PAYMENT");
    expect(await ticker.isAdmitted(eventId, jti)).toBe(false);
    expect(await ticker.counts(eventId)).toEqual({ queued: 0, active: 0 });
  });

  test("placing an order succeeds even when the queue store is unavailable", async () => {
    const { eventId, afterOnSale } = await scheduledEvent();
    const alice = guest();
    const { seatIds } = await freeSeats(db(), 1, { eventId });
    const seat = { id: seatIds[0] ?? "" };
    const unavailable = (now: Date) =>
      createCaller({
        now: () => now,
        principal: alice,
        isAdmin: false,
        bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
        db,
        logger: silentLogger,
        metrics: () => ({ increment: async () => undefined }),
        metricsReader: () => {
          throw new Error("metrics are not read here");
        },
        metricsReset: () => {
          throw new Error("metrics are not reset here");
        },
        workerHealth: () => {
          throw new Error("worker health is not read here");
        },
        rateLimiter: () => {
          throw new Error("nothing is rate-limited here");
        },
        queueStore: () => Promise.reject(new Error("redis is down")),
        random: { next: () => 0.5 },
        admissionTokens: admissionTokensFor(alice, now),
      });
    await admitted(eventId, afterOnSale, alice);
    // The hold needs the admitted set in Redis; the order must not.
    const hold = await caller(alice, afterOnSale).booking.holdSeats({
      eventId,
      seatIds: [seat.id],
    });

    const order = await unavailable(afterOnSale).booking.placeOrder({
      holdId: hold.id,
      contact: { email: "alice@example.com" },
      idempotencyKey: randomUUID(),
    });

    expect(order.status).toBe("PENDING_PAYMENT");
  });
});
