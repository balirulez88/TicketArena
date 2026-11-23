import { randomUUID } from "node:crypto";
import { DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import {
  freeSeats,
  NOW,
  type OccupyOptions,
  occupy,
  slowStart,
  testClients,
  withClient,
} from "@ticketarena/booking/testing";
import { silentLogger } from "@ticketarena/contracts";
import { seedCatalog } from "@ticketarena/db";
import { setupTestDatabase, setupTestRedis } from "@ticketarena/test-infra";
import { createRedisQueueStore } from "@ticketarena/waiting-room";
import { SignJWT } from "jose";
import { createClient } from "redis";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createBrowserCookies } from "../testing/browser-cookies";
import { createCaller } from "./_app";

const database = setupTestDatabase();
const redis = setupTestRedis();
const redisClient = createClient({ url: redis.url });
const { db, open } = testClients(database);

// Fresh per test: the buyer limit counts a buyer's seats across the shared database.
let alice: Principal = { kind: "guest", sessionId: "a".repeat(32) };
const bob: Principal = { kind: "guest", sessionId: "b".repeat(32) };

const ADMISSION_SECRET = "k".repeat(32);

const browser = createBrowserCookies(ADMISSION_SECRET);
const jarOf = (principal: Principal) => browser.jarOf(principal.sessionId);
const admissionTokensFor = (principal: Principal, now: Date) =>
  browser.admissionTokens(principal.sessionId, now);

const queueStore = async () => createRedisQueueStore(redisClient, { prefix: redis.prefix });

function caller(principal: Principal, now: Date = NOW) {
  return createCaller({
    now: () => now,
    principal,
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db: db(),
    logger: silentLogger,
    metrics: () => ({ increment: async () => undefined }),
    metricsReader: () => {
      throw new Error("metrics are not read here");
    },
    metricsReset: () => {
      throw new Error("metrics are not reset here");
    },
    rateLimiter: () => {
      throw new Error("nothing is rate-limited here");
    },
    queueStore,
    random: { next: () => 0 },
    admissionTokens: admissionTokensFor(principal, now),
  });
}

/**
 * Admits the session the way a browser is: join (the seeded demo event's queue has closed, so
 * join admits at once), then the status poll that stores the admission token in its cookies.
 */
async function admit(principal: Principal, eventId: string, now: Date = NOW): Promise<void> {
  await caller(principal, now).queue.join({ eventId });
  await caller(principal, now).queue.status({ eventId });
}

async function demoEventId(): Promise<string> {
  return (await db().event.findFirstOrThrow({ where: { demo: true } })).id;
}

beforeAll(async () => {
  await redisClient.connect();
  await withClient(database, (seeding) => seedCatalog(seeding, NOW));
});

beforeEach(async () => {
  alice = { kind: "guest", sessionId: randomUUID().replaceAll("-", "") };
  const eventId = await demoEventId();
  await admit(alice, eventId);
  // Re-joining keeps an admission; bob is admitted with the test's own client.
  await admit(bob, eventId);
});

afterAll(() => {
  redisClient.destroy();
});

describe("booking.holdSeats", () => {
  test("holds a seat and returns the hold with its expiry", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";

    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    expect(hold).toMatchObject({
      eventId,
      seatIds: [seatId],
      status: "HELD",
      holdExpiresAt: new Date("2027-03-01T12:10:00.000Z"),
    });
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).claimBuyerKey).toBe(
      alice.sessionId,
    );
  });

  test("a seat that is already held is CONFLICT naming SEAT_UNAVAILABLE and the seat id", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(
      caller(bob).booking.holdSeats({ eventId, seatIds: [seatId] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(`SEAT_UNAVAILABLE: ${seatId}`),
    });
  });

  test("before the event's on-sale is PRECONDITION_FAILED naming NOT_ON_SALE, and nothing is held", async () => {
    const upcoming = await db().event.findFirstOrThrow({ where: { demo: false } });
    const { seatIds } = await freeSeats(db(), 1, { eventId: upcoming.id });
    const seat = { id: seatIds[0] ?? "" };
    // No real path admits before the on-sale; an admission from a clock past the queue close,
    // presented earlier, shows the refusal holds whatever admission the buyer has.
    await admit(alice, upcoming.id, upcoming.queueClosesAt);

    await expect(
      caller(alice).booking.holdSeats({ eventId: upcoming.id, seatIds: [seat.id] }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("NOT_ON_SALE"),
    });
    expect((await db().seat.findUniqueOrThrow({ where: { id: seat.id } })).status).toBe(
      "AVAILABLE",
    );
  });

  test("rejects a malformed seat id naming the field", async () => {
    const { eventId } = await freeSeats(db(), 1);

    await expect(
      caller(alice).booking.holdSeats({ eventId, seatIds: ["nope"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("seatIds") });
  });
});

describe("booking.holdSeats seat-count boundary", () => {
  test("rejects zero and seven seat ids as BAD_REQUEST naming seatIds", async () => {
    const { eventId } = await freeSeats(db(), 1);
    const seven = Array.from({ length: 7 }, () => randomUUID());

    for (const seatIds of [[], seven]) {
      await expect(caller(alice).booking.holdSeats({ eventId, seatIds })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("seatIds"),
      });
    }
  });

  test("holds six seats of one event in one call", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 6);

    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds });

    expect(hold.seatIds).toHaveLength(6);
  });

  test("a hold past the six-seat buyer limit is CONFLICT naming LIMIT_EXCEEDED and holds nothing", async () => {
    const event = await db().event.findFirstOrThrow({ where: { demo: true } });
    const [extra, ...six] = (await freeSeats(db(), 7, { eventId: event.id })).seatIds;
    if (extra === undefined) {
      throw new Error("the demo event needs 7 free seats");
    }
    await caller(alice).booking.holdSeats({ eventId: event.id, seatIds: six });

    await expect(
      caller(alice).booking.holdSeats({ eventId: event.id, seatIds: [extra] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("LIMIT_EXCEEDED"),
    });
    expect(await db().seat.findUniqueOrThrow({ where: { id: extra } })).toMatchObject({
      status: "AVAILABLE",
      holdId: null,
      claimBuyerKey: null,
    });
    expect(await db().hold.count({ where: { buyerKey: alice.sessionId } })).toBe(1);
  });

  test("seats of another event are CONFLICT and nothing is held", async () => {
    const demo = await db().event.findFirstOrThrow({ where: { demo: true } });
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });
    const { seatIds } = await freeSeats(db(), 1, { eventId: other.id });
    const foreign = { id: seatIds[0] ?? "" };

    await expect(
      caller(alice).booking.holdSeats({ eventId: demo.id, seatIds: [foreign.id] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db().seat.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe(
      "AVAILABLE",
    );
  });
});

describe("booking.getHold", () => {
  test("returns the hold to its owner", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    expect(await caller(alice).booking.getHold({ holdId: hold.id })).toEqual(hold);
  });

  test("is NOT_FOUND for anyone but the owner", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(caller(bob).booking.getHold({ holdId: hold.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("booking.releaseHold", () => {
  test("releases the owner's hold and another buyer can hold the seat at once", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    const released = await caller(alice).booking.releaseHold({ holdId: hold.id });
    const bobs = await caller(bob).booking.holdSeats({ eventId, seatIds: [seatId] });

    expect(released).toMatchObject({ id: hold.id, status: "RELEASED", seatIds: [seatId] });
    expect(bobs).toMatchObject({ status: "HELD", seatIds: [seatId] });
    await caller(bob).booking.releaseHold({ holdId: bobs.id });
  });

  test("is NOT_FOUND for anyone but the owner and CONFLICT for a hold no longer HELD", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(caller(bob).booking.releaseHold({ holdId: hold.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await caller(alice).booking.releaseHold({ holdId: hold.id });
    await expect(caller(alice).booking.releaseHold({ holdId: hold.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("HOLD_NOT_ACTIVE"),
    });
  });

  test("rejects a malformed hold id naming the field", async () => {
    await expect(caller(alice).booking.releaseHold({ holdId: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("holdId"),
    });
  });
});

describe("booking.placeOrder / getOrder", () => {
  const contact = { email: "alice@example.com" };

  async function heldHold() {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    return caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });
  }

  test("places an order without admission and is idempotent per key", async () => {
    const hold = await heldHold();
    const idempotencyKey = randomUUID();

    const order = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey,
    });
    const replay = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey,
    });

    expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT", contact });
    expect(replay).toEqual(order);
    expect(await caller(alice).booking.getOrder({ orderId: order.id })).toEqual(order);
  });

  test("getOrder is NOT_FOUND for anyone but the owner", async () => {
    const hold = await heldHold();
    const order = await caller(alice).booking.placeOrder({
      holdId: hold.id,
      contact,
      idempotencyKey: randomUUID(),
    });

    await expect(caller(bob).booking.getOrder({ orderId: order.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("maps domain refusals to tRPC codes", async () => {
    const hold = await heldHold();
    const idempotencyKey = randomUUID();
    await caller(alice).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey });

    await expect(
      caller(bob).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(alice).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "x@example.com" },
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("IDEMPOTENCY_KEY_REUSED"),
    });
    await expect(
      caller(alice).booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("HOLD_NOT_ACTIVE"),
    });
  });

  test("HOLD_EXPIRED is a PRECONDITION_FAILED", async () => {
    const hold = await heldHold();
    const late = caller(alice, new Date("2027-03-01T12:10:00.000Z"));

    await expect(
      late.booking.placeOrder({ holdId: hold.id, contact, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("HOLD_EXPIRED"),
    });
  });

  test("rejects a malformed email naming the field", async () => {
    const hold = await heldHold();

    await expect(
      caller(alice).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "nope" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("email") });
  });
});

describe("booking.holdSeats saturation", () => {
  async function expectHoldRefusedAsBusy(occupyOptions?: OccupyOptions): Promise<void> {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const tight = open({ poolMax: 1, acquireTimeoutMs: 100 });
    // TD-071: the pool is full only once occupy has signalled that its query ran.
    const occupation = await occupy(tight, occupyOptions);
    try {
      await expect(
        createCaller({
          now: () => NOW,
          principal: alice,
          isAdmin: false,
          bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
          db: tight,
          logger: silentLogger,
          metrics: () => ({ increment: async () => undefined }),
          metricsReader: () => {
            throw new Error("metrics are not read here");
          },
          metricsReset: () => {
            throw new Error("metrics are not reset here");
          },
          rateLimiter: () => {
            throw new Error("nothing is rate-limited here");
          },
          queueStore,
          random: { next: () => 0 },
          admissionTokens: admissionTokensFor(alice, NOW),
        }).booking.holdSeats({ eventId, seatIds: [seatId] }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS", message: /BOOKING_BUSY/ });
    } finally {
      await occupation.release();
    }
  }

  test("a database that cannot take the request in time is TOO_MANY_REQUESTS (BOOKING_BUSY)", async () => {
    await expectHoldRefusedAsBusy();
  });

  test("the request waits for an occupier that is slow to start", async () => {
    await expectHoldRefusedAsBusy({ beforeStart: slowStart });
  });
});

describe("booking.holdSeats admission (AT-40)", () => {
  function guest(): Principal {
    return { kind: "guest", sessionId: randomUUID().replaceAll("-", "") };
  }

  async function expectForbidden(principal: Principal, now: Date = NOW): Promise<void> {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    await expect(
      caller(principal, now).booking.holdSeats({ eventId, seatIds: [seatId] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("AVAILABLE");
  }

  test("without an admission token is FORBIDDEN and nothing is held", async () => {
    await expectForbidden(guest());
  });

  test("with an expired admission token is FORBIDDEN", async () => {
    const carol = guest();
    await admit(carol, await demoEventId());

    await expectForbidden(carol, new Date(NOW.getTime() + 30 * 60_000));
  });

  test("with another session's admission token is FORBIDDEN", async () => {
    const eventId = await demoEventId();
    const [carol, mallory] = [guest(), guest()];
    await admit(carol, eventId);
    jarOf(mallory).set(`ta_adm_${eventId}`, jarOf(carol).get(`ta_adm_${eventId}`) ?? "");

    await expectForbidden(mallory);
  });

  test("with another event's admission token is FORBIDDEN", async () => {
    const demoId = await demoEventId();
    const other = await db().event.findFirstOrThrow({ where: { demo: false } });
    const carol = guest();
    // Admitted to the other event (its queue has closed by then), never to the demo event.
    await admit(carol, other.id, other.queueClosesAt);
    jarOf(carol).set(`ta_adm_${demoId}`, jarOf(carol).get(`ta_adm_${other.id}`) ?? "");

    await expectForbidden(carol);
  });

  test("with a revoked admission (the slot was freed by leaving) is FORBIDDEN", async () => {
    const eventId = await demoEventId();
    const carol = guest();
    await admit(carol, eventId);
    await caller(carol).queue.leave({ eventId });

    expect(jarOf(carol).has(`ta_adm_${eventId}`)).toBe(true);
    await expectForbidden(carol);
  });

  test("with a token signed under another secret is FORBIDDEN", async () => {
    const eventId = await demoEventId();
    const carol = guest();
    await admit(carol, eventId);
    const { jti } = JSON.parse(
      Buffer.from(
        jarOf(carol).get(`ta_adm_${eventId}`)?.split(".")[1] ?? "",
        "base64url",
      ).toString(),
    ) as { jti: string };
    const forged = await new SignJWT({ eid: eventId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(carol.sessionId)
      .setJti(jti)
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 600)
      .sign(new TextEncoder().encode("f".repeat(32)));
    jarOf(carol).set(`ta_adm_${eventId}`, forged);

    await expectForbidden(carol);
  });

  test("with a valid admission holds the seats", async () => {
    const carol = guest();
    await admit(carol, await demoEventId());
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";

    await expect(
      caller(carol).booking.holdSeats({ eventId, seatIds: [seatId] }),
    ).resolves.toMatchObject({ status: "HELD" });
  });
});

describe("booking.placeOrder without admission (AT-41)", () => {
  const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

  test("succeeds after the admission expired while the hold is valid", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    // Admitted at NOW (beforeEach), held at +25 min: the hold runs to +35, the admission to +30.
    const hold = await caller(alice, minutes(25)).booking.holdSeats({
      eventId,
      seatIds: [seatId],
    });
    await expect(
      caller(alice, minutes(31)).booking.holdSeats({ eventId, seatIds: [seatId] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const order = await caller(alice, minutes(31)).booking.placeOrder({
      holdId: hold.id,
      contact: { email: "alice@example.com" },
      idempotencyKey: randomUUID(),
    });

    expect(order).toMatchObject({ holdId: hold.id, status: "PENDING_PAYMENT" });
  });

  test("fails for a hold owned by another buyer, even an admitted one", async () => {
    const { eventId, seatIds } = await freeSeats(db(), 1);
    const seatId = seatIds[0] ?? "";
    const hold = await caller(alice).booking.holdSeats({ eventId, seatIds: [seatId] });

    await expect(
      caller(bob).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "bob@example.com" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db().hold.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe("HELD");
  });
});
