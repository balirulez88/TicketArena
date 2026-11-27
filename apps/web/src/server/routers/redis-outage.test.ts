import { randomUUID } from "node:crypto";
import { DEFAULT_BOOKING_TIMEOUTS } from "@ticketarena/booking";
import { freeSeats, NOW, testClients, withClient } from "@ticketarena/booking/testing";
import type { Logger } from "@ticketarena/contracts";
import { seedCatalog } from "@ticketarena/db/seed";
import {
  type RedisStandInMode,
  setupRedisStandIn,
  setupTestDatabase,
} from "@ticketarena/test-infra";
import type { QueueStore } from "@ticketarena/waiting-room";
import { SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Principal } from "../identity/identity";
import { createLazyQueueStore } from "../queue-store";
import { createBrowserCookies } from "../testing/browser-cookies";
import { createCaller } from "./_app";

// Ticket 63: Redis decides only queue order and admission (ADR 0005, ADR 0008), so an outage must
// fail fast where Redis is needed and leave everything else working. The Redis here is real: a
// local stand-in in front of the test Redis that the tests stop (`closed`) or hang (`silent`).

const database = setupTestDatabase();
const standIn = setupRedisStandIn();
const { db } = testClients(database);

// Injected like the production config (REDIS_*_TIMEOUT_MS); roomy enough for a loaded machine.
const REDIS_TIMEOUT_MS = 2000;
// Generous against a slow CI machine, yet far below the 30 s test timeout a hang would hit.
const BOUND_MS = 15_000;

const ADMISSION_SECRET = "o".repeat(32);
const secretKey = new TextEncoder().encode(ADMISSION_SECRET);
const browser = createBrowserCookies(ADMISSION_SECRET);
const cookieName = (eventId: string) => `ta_adm_${eventId}`;

interface LogLine {
  readonly level: "warn" | "error";
  readonly fields: object;
  readonly message: string;
}

let logs: LogLine[] = [];
const logger: Logger = {
  info: () => undefined,
  warn: (fields, message) => {
    logs.push({ level: "warn", fields, message: message ?? "" });
  },
  error: (fields, message) => {
    logs.push({ level: "error", fields, message: message ?? "" });
  },
  child: () => logger,
};

// One store per test, on its own key namespace and with its own client, so a client one test
// left reconnecting never answers for the next.
let queueStore: () => Promise<QueueStore> = () => Promise.reject(new Error("no store yet"));

beforeAll(async () => {
  await withClient(database, (seeding) => seedCatalog(seeding, NOW));
});

beforeEach(async () => {
  logs = [];
  await standIn.setMode("forward");
  queueStore = createLazyQueueStore({
    readEnv: () => ({
      REDIS_URL: standIn.url,
      REDIS_CONNECT_TIMEOUT_MS: String(REDIS_TIMEOUT_MS),
      REDIS_COMMAND_TIMEOUT_MS: String(REDIS_TIMEOUT_MS),
    }),
    logger,
    prefix: `${standIn.prefix}${randomUUID()}:`,
  });
});

function guest(): Principal {
  return { kind: "guest", sessionId: randomUUID().replaceAll("-", "") };
}

function caller(principal: Principal, now: Date = NOW) {
  return createCaller({
    now: () => now,
    principal,
    isAdmin: false,
    bookingTimeouts: DEFAULT_BOOKING_TIMEOUTS,
    db,
    logger,
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
    queueStore: () => queueStore(),
    random: { next: () => 0.5 },
    admissionTokens: browser.admissionTokens(principal.sessionId, now),
  });
}

async function demoEventId(): Promise<string> {
  return (await db().event.findFirstOrThrow({ where: { demo: true } })).id;
}

/** Admits the session like a browser while Redis is up: join (the demo queue has closed), then status. */
async function admitted(principal: Principal = guest()) {
  const eventId = await demoEventId();
  await caller(principal).queue.join({ eventId });
  await caller(principal).queue.status({ eventId });
  const token = browser.jarOf(principal.sessionId).get(cookieName(eventId));
  if (token === undefined) {
    throw new Error("the status poll minted no admission token");
  }
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    jti: string;
    exp: number;
  };
  return { principal, eventId, token, ...claims };
}

/** Runs `call`, reporting how it settled and how long it took. */
async function timed<T>(call: () => Promise<T>) {
  const started = performance.now();
  const outcome = await call().then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  return { ...outcome, elapsedMs: performance.now() - started };
}

async function holdOne(principal: Principal, eventId: string) {
  const { seatIds } = await freeSeats(db(), 1, { eventId });
  const seatId = seatIds[0] ?? "";
  const result = await timed(() =>
    caller(principal).booking.holdSeats({ eventId, seatIds: [seatId] }),
  );
  const seat = await db().seat.findUniqueOrThrow({ where: { id: seatId } });
  return { ...result, seatStatus: seat.status };
}

/** Signs an admission token with the test's secret unless told otherwise. */
function forge(
  claims: { sub: string; eid: string; jti: string; exp: number },
  { alg = "HS256", key = secretKey }: { alg?: string; key?: Uint8Array } = {},
) {
  return new SignJWT({ eid: claims.eid })
    .setProtectedHeader({ alg, typ: "JWT" })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setExpirationTime(claims.exp)
    .sign(key);
}

function unsigned(claims: { sub: string; eid: string; jti: string; exp: number }): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
}

const OUTAGES: readonly RedisStandInMode[] = ["closed", "silent"];

describe.each(OUTAGES)("with Redis %s", (outage) => {
  test("queue.join, queue.status and queue.leave fail within a bounded time as SERVICE_UNAVAILABLE", async () => {
    const eventId = await demoEventId();
    const alice = guest();
    await standIn.setMode(outage);

    const calls: (() => Promise<unknown>)[] = [
      () => caller(alice).queue.join({ eventId }),
      () => caller(alice).queue.status({ eventId }),
      () => caller(alice).queue.leave({ eventId }),
    ];
    for (const call of calls) {
      const { error, elapsedMs } = await timed(call);
      expect(error).toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: expect.stringContaining("waiting room is unavailable"),
      });
      expect(elapsedMs).toBeLessThan(BOUND_MS);
    }
  });

  test("no new admission is issued: an admitted session's join and status poll mint no token", async () => {
    const { principal, eventId } = await admitted();
    const jar = browser.jarOf(principal.sessionId);
    jar.delete(cookieName(eventId));
    await standIn.setMode(outage);

    await expect(caller(principal).queue.join({ eventId })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    await expect(caller(principal).queue.status({ eventId })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });

    expect(jar.has(cookieName(eventId))).toBe(false);
  });

  test("placeOrder commits the order within a bounded time and logs the failed slot release", async () => {
    const { principal, eventId } = await admitted();
    const { seatIds } = await freeSeats(db(), 1, { eventId });
    const hold = await caller(principal).booking.holdSeats({ eventId, seatIds });
    await standIn.setMode(outage);

    const { value: order, elapsedMs } = await timed(() =>
      caller(principal).booking.placeOrder({
        holdId: hold.id,
        contact: { email: "alice@example.com" },
        idempotencyKey: randomUUID(),
      }),
    );

    expect(order?.status).toBe("PENDING_PAYMENT");
    expect(elapsedMs).toBeLessThan(BOUND_MS);
    expect(await db().order.findUniqueOrThrow({ where: { id: order?.id ?? "" } })).toMatchObject({
      status: "PENDING_PAYMENT",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("slot release") }),
    );
  });

  test("a valid admission token holds seats, skipping only the revocation lookup, and the warning names the event, never the token", async () => {
    const { principal, eventId, token, jti } = await admitted();
    await standIn.setMode(outage);

    const { value: hold, elapsedMs, seatStatus } = await holdOne(principal, eventId);

    expect(hold?.status).toBe("HELD");
    expect(seatStatus).toBe("HELD");
    expect(elapsedMs).toBeLessThan(BOUND_MS);
    const skipped = logs.filter((line) => line.message.includes("revocation check skipped"));
    expect(skipped).toHaveLength(1);
    const logged = JSON.stringify(skipped);
    expect(logged).toContain(eventId);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(jti);
  });

  test("a revoked admission token stays usable until its expiry (the accepted outage risk)", async () => {
    const { principal, eventId } = await admitted();
    await caller(principal).queue.leave({ eventId });
    await standIn.setMode(outage);

    const { value: hold } = await holdOne(principal, eventId);

    expect(hold?.status).toBe("HELD");
  });
});

describe.each(["reachable", ...OUTAGES] as const)(
  "a token that fails its own checks is FORBIDDEN with Redis %s",
  (redisState) => {
    const outage = async () => {
      if (redisState !== "reachable") {
        await standIn.setMode(redisState);
      }
    };

    async function expectForbidden(principal: Principal, eventId: string, token: string) {
      browser.jarOf(principal.sessionId).set(cookieName(eventId), token);
      await outage();
      const { error, elapsedMs, seatStatus } = await holdOne(principal, eventId);
      expect(error).toMatchObject({ code: "FORBIDDEN" });
      expect(seatStatus).toBe("AVAILABLE");
      expect(elapsedMs).toBeLessThan(BOUND_MS);
    }

    test("a bad signature", async () => {
      const { principal, eventId, jti, exp } = await admitted();
      const token = await forge(
        { sub: principal.sessionId, eid: eventId, jti, exp },
        { key: new TextEncoder().encode("f".repeat(32)) },
      );
      await expectForbidden(principal, eventId, token);
    });

    test("another algorithm (HS384) under the right secret", async () => {
      const { principal, eventId, jti, exp } = await admitted();
      const token = await forge(
        { sub: principal.sessionId, eid: eventId, jti, exp },
        { alg: "HS384" },
      );
      await expectForbidden(principal, eventId, token);
    });

    test("an unsigned token (alg none)", async () => {
      const { principal, eventId, jti, exp } = await admitted();
      await expectForbidden(
        principal,
        eventId,
        unsigned({ sub: principal.sessionId, eid: eventId, jti, exp }),
      );
    });

    test("a past exp", async () => {
      const { principal, eventId, jti } = await admitted();
      const past = Math.floor(NOW.getTime() / 1000) - 1;
      const token = await forge({ sub: principal.sessionId, eid: eventId, jti, exp: past });
      await expectForbidden(principal, eventId, token);
    });

    test("another session", async () => {
      const { eventId, token } = await admitted();
      await expectForbidden(guest(), eventId, token);
    });

    test("another event", async () => {
      const { principal, eventId, jti, exp } = await admitted();
      const other = await db().event.findFirstOrThrow({ where: { demo: false } });
      const token = await forge({ sub: principal.sessionId, eid: other.id, jti, exp });
      await expectForbidden(principal, eventId, token);
    });
  },
);

describe("with Redis reachable, the revocation lookup decides", () => {
  test("a token whose jti is missing from the admitted set is FORBIDDEN", async () => {
    const { principal, eventId, exp } = await admitted();
    const token = await forge({ sub: principal.sessionId, eid: eventId, jti: randomUUID(), exp });
    browser.jarOf(principal.sessionId).set(cookieName(eventId), token);

    const { error, seatStatus } = await holdOne(principal, eventId);

    expect(error).toMatchObject({ code: "FORBIDDEN" });
    expect(seatStatus).toBe("AVAILABLE");
  });

  test("a revoked token (the slot was freed) is FORBIDDEN", async () => {
    const { principal, eventId } = await admitted();
    await caller(principal).queue.leave({ eventId });

    const { error, seatStatus } = await holdOne(principal, eventId);

    expect(error).toMatchObject({ code: "FORBIDDEN" });
    expect(seatStatus).toBe("AVAILABLE");
    expect(logs.some((line) => line.message.includes("revocation check skipped"))).toBe(false);
  });

  test("a Redis that refuses the handshake (wrong password) answered: a revoked token still fails, never skipped", async () => {
    const { principal, eventId } = await admitted();
    await caller(principal).queue.leave({ eventId });
    const wrongPassword = new URL(standIn.url);
    wrongPassword.username = "no-such-user";
    wrongPassword.password = "wrong";
    queueStore = createLazyQueueStore({
      readEnv: () => ({
        REDIS_URL: wrongPassword.toString(),
        REDIS_CONNECT_TIMEOUT_MS: String(REDIS_TIMEOUT_MS),
        REDIS_COMMAND_TIMEOUT_MS: String(REDIS_TIMEOUT_MS),
      }),
      logger,
      prefix: `${standIn.prefix}${randomUUID()}:`,
    });

    const { value: hold, error, seatStatus } = await holdOne(principal, eventId);

    expect(hold).toBeUndefined();
    expect(error).toBeDefined();
    expect(seatStatus).toBe("AVAILABLE");
    expect(logs.some((line) => line.message.includes("revocation check skipped"))).toBe(false);
  });
});
