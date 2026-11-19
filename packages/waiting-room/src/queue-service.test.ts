import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ADMISSION_TTL_MS,
  createQueueService,
  createRedisQueueStore,
  createScheduleAdmissionPolicy,
  type EventSchedule,
  type Random,
} from "./index";

const redis = setupTestRedis();
const client = createClient({ url: redis.url });

beforeAll(async () => {
  await client.connect();
});

afterAll(() => {
  client.destroy();
});

const ON_SALE = new Date("2027-05-01T10:00:00.000Z");
const BEFORE_ON_SALE = new Date("2027-05-01T09:58:00.000Z");
const AFTER_ON_SALE = new Date("2027-05-01T10:02:00.000Z");

function schedule(): EventSchedule {
  return {
    id: randomUUID(),
    onSaleAt: ON_SALE,
    queueOpensAt: new Date("2027-05-01T09:55:00.000Z"),
    queueClosesAt: new Date("2027-05-01T11:00:00.000Z"),
  };
}

/** Scripted randomness: hands out the given values in order, then fails loudly. */
function scriptedRandom(values: readonly number[]): Random {
  const remaining = [...values];
  return {
    next() {
      const value = remaining.shift();
      if (value === undefined) {
        throw new Error("scriptedRandom: out of values");
      }
      return value;
    },
  };
}

function serviceAt(clock: { now: Date }, random: Random = scriptedRandom([]), admitRate = 10) {
  return createQueueService({
    store: createRedisQueueStore(client, { prefix: `${redis.prefix}service:` }),
    policy: createScheduleAdmissionPolicy(),
    clock: { now: () => clock.now },
    random,
    newId: randomUUID,
    admitRatePerSecond: admitRate,
  });
}

describe("QueueService.join", () => {
  test("AT-36: pre-queue joins are all ahead of later joins, ordered by the injected randomness; later joins are FIFO", async () => {
    const event = schedule();
    const clock = { now: BEFORE_ON_SALE };
    const service = serviceAt(clock, scriptedRandom([0.9, 0.1, 0.5]));

    await service.join(event, "pre-a");
    await service.join(event, "pre-b");
    await service.join(event, "pre-c");
    clock.now = AFTER_ON_SALE;
    await service.join(event, "late-d");
    await service.join(event, "late-e");
    await service.join(event, "late-f");

    const order = ["pre-b", "pre-c", "pre-a", "late-d", "late-e", "late-f"];
    for (const [index, sessionId] of order.entries()) {
      expect(await service.status(event.id, sessionId)).toMatchObject({
        status: "QUEUED",
        position: index + 1,
      });
    }
  });

  test("a pre-queue join is ahead of later joins even with a random value just below 1", async () => {
    const event = schedule();
    const clock = { now: AFTER_ON_SALE };
    const service = serviceAt(clock, scriptedRandom([0.999_999_999]));
    await service.join(event, "late");
    clock.now = BEFORE_ON_SALE;

    const result = await service.join(event, "early");

    expect(result).toMatchObject({ status: "QUEUED", position: 1 });
  });

  test("AT-37: re-joining keeps the position", async () => {
    const event = schedule();
    const clock = { now: BEFORE_ON_SALE };
    const service = serviceAt(clock, scriptedRandom([0.7, 0.2, 0.01, 0.01]));
    await service.join(event, "a");
    await service.join(event, "b");
    clock.now = AFTER_ON_SALE;
    await service.join(event, "c");

    expect(await service.join(event, "a")).toMatchObject({ status: "QUEUED", position: 2 });
    clock.now = BEFORE_ON_SALE;
    expect(await service.join(event, "a")).toMatchObject({ status: "QUEUED", position: 2 });
    expect(await service.join(event, "b")).toMatchObject({ status: "QUEUED", position: 1 });
    clock.now = AFTER_ON_SALE;
    expect(await service.join(event, "c")).toMatchObject({ status: "QUEUED", position: 3 });
  });

  test("before queueOpensAt, join answers NOT_OPEN with the opening time, queues nothing and admits no one", async () => {
    const event = schedule();
    const clock = { now: new Date("2027-05-01T09:54:59.999Z") };
    const service = serviceAt(clock);

    expect(await service.join(event, "too-early")).toEqual({
      status: "NOT_OPEN",
      queueOpensAt: event.queueOpensAt,
    });

    expect(await service.status(event.id, "too-early")).toEqual({ status: "NOT_QUEUED" });
    expect(await service.counts(event.id)).toEqual({ queued: 0, active: 0 });
  });

  test("at exactly queueOpensAt, join queues the buyer in the pre-queue", async () => {
    const event = schedule();
    const clock = { now: event.queueOpensAt };
    const service = serviceAt(clock, scriptedRandom([0.9]));

    expect(await service.join(event, "first")).toMatchObject({ status: "QUEUED", position: 1 });

    clock.now = AFTER_ON_SALE;
    await service.join(event, "later");
    // A later join scores at least 2, so "first" holds a pre-queue score in [0, 1).
    expect(await service.status(event.id, "first")).toMatchObject({ position: 1 });
  });

  test("at or after queueClosesAt, join reports immediate admission eligibility and queues nothing", async () => {
    const event = schedule();
    const clock = { now: event.queueClosesAt };
    const service = serviceAt(clock);

    expect(await service.join(event, "at-close")).toEqual({ status: "ADMISSIBLE" });
    clock.now = new Date("2027-05-01T12:00:00.000Z");
    expect(await service.join(event, "after-close")).toEqual({ status: "ADMISSIBLE" });

    expect(await service.status(event.id, "at-close")).toEqual({ status: "NOT_QUEUED" });
    expect(await service.status(event.id, "after-close")).toEqual({ status: "NOT_QUEUED" });
  });
});

describe("QueueService.status", () => {
  test("reports the position and an ETA of position / admit rate, rounded up", async () => {
    const event = schedule();
    const service = serviceAt({ now: AFTER_ON_SALE }, scriptedRandom([]), 2);
    for (const sessionId of ["a", "b", "c"]) {
      await service.join(event, sessionId);
    }

    expect(await service.status(event.id, "a")).toEqual({
      status: "QUEUED",
      position: 1,
      etaSeconds: 1,
    });
    expect(await service.status(event.id, "c")).toEqual({
      status: "QUEUED",
      position: 3,
      etaSeconds: 2,
    });
  });
});

describe("QueueService.leave", () => {
  test("removes the buyer and moves everyone behind up", async () => {
    const event = schedule();
    const service = serviceAt({ now: AFTER_ON_SALE });
    await service.join(event, "a");
    await service.join(event, "b");

    expect(await service.leave(event.id, "a")).toEqual({ left: true });

    expect(await service.status(event.id, "a")).toEqual({ status: "NOT_QUEUED" });
    expect(await service.status(event.id, "b")).toMatchObject({ position: 1 });
    expect(await service.leave(event.id, "a")).toEqual({ left: false });
  });
});

describe("QueueService admission (ticker, slots, reaper)", () => {
  const LIMITS = { admitRate: 3, maxActive: 5 };
  const atOffset = (ms: number) => new Date(AFTER_ON_SALE.getTime() + ms);

  async function queued(clock: { now: Date }, count: number) {
    const event = schedule();
    const service = serviceAt(clock);
    const sessions = Array.from({ length: count }, (_, index) => `s${index + 1}`);
    for (const sessionId of sessions) {
      await service.join(event, sessionId);
    }
    return { event, service, sessions };
  }

  test("admitTick admits from the head into the active set; status then reports ADMITTED", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 4);

    const admitted = await service.admitTick(event, LIMITS);

    expect(admitted.map((admission) => admission.sessionId)).toEqual(["s1", "s2", "s3"]);
    expect(await service.status(event.id, "s1")).toEqual({ status: "ADMITTED" });
    expect(await service.status(event.id, "s4")).toMatchObject({ status: "QUEUED", position: 1 });
    expect(await service.counts(event.id)).toEqual({ queued: 1, active: 3 });
    for (const admission of admitted) {
      expect(await service.isAdmitted(event.id, admission.jti)).toBe(true);
    }
  });

  test("a session holding a slot joins again: ADMITTED, still one slot, its jti still valid after more ticks", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 4);
    const [first] = await service.admitTick(event, LIMITS);

    expect(await service.join(event, "s1")).toEqual({ status: "ADMITTED" });

    clock.now = atOffset(1_000);
    expect((await service.admitTick(event, LIMITS)).map((next) => next.sessionId)).toEqual(["s4"]);
    expect(await service.isAdmitted(event.id, first?.jti ?? "")).toBe(true);
    expect(await service.counts(event.id)).toEqual({ queued: 0, active: 4 });
  });

  test("a session whose slot was freed joins again at the back of the queue", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 4);
    await service.admitTick(event, LIMITS);
    await service.releaseSlot(event.id, "s1");

    expect(await service.join(event, "s1")).toMatchObject({ status: "QUEUED", position: 2 });
  });

  test("admits no one before onSaleAt, then admits the pre-queue in its random order", async () => {
    // Admitting during the pre-queue would serve early arrivals first and make the random
    // pre-queue order (ADR 0008) meaningless.
    const event = schedule();
    const clock = { now: BEFORE_ON_SALE };
    const service = serviceAt(clock, scriptedRandom([0.9, 0.1, 0.5]));
    for (const sessionId of ["p1", "p2", "p3"]) {
      await service.join(event, sessionId);
    }

    expect(await service.admitTick(event, LIMITS)).toEqual([]);
    clock.now = new Date(ON_SALE.getTime() - 1);
    expect(await service.admitTick(event, LIMITS)).toEqual([]);
    expect(await service.counts(event.id)).toEqual({ queued: 3, active: 0 });

    clock.now = ON_SALE;
    const admitted = await service.admitTick(event, LIMITS);

    expect(admitted.map((admission) => admission.sessionId)).toEqual(["p2", "p3", "p1"]);
  });

  test("AT-38: one-second ticks never admit more than admitRate per tick or beyond maxActive", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 20);

    const perTick: number[] = [];
    for (let second = 0; second < 4; second += 1) {
      clock.now = atOffset(second * 1000);
      perTick.push((await service.admitTick(event, LIMITS)).length);
      // Ticks in the same second find the bucket empty.
      perTick.push((await service.admitTick(event, LIMITS)).length);
    }

    expect(perTick).toEqual([3, 0, 2, 0, 0, 0, 0, 0]);
    expect(await service.counts(event.id)).toEqual({ queued: 15, active: 5 });
  });

  test("status polls heartbeat the slot, so a polling buyer is not reaped as idle", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 2);
    await service.admitTick(event, { admitRate: 2, maxActive: 5 });

    clock.now = atOffset(60_000);
    await service.status(event.id, "s1");
    expect(await service.heartbeat(event.id, "s2")).toBe(true);
    expect(await service.heartbeat(event.id, "never-admitted")).toBe(false);
    clock.now = atOffset(120_000);

    expect(await service.reap(event.id)).toEqual([]);
  });

  test("AT-39: reaping frees a slot idle for over 90s and revokes its admission", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 2);
    const [idle, polling] = await service.admitTick(event, { admitRate: 2, maxActive: 5 });
    clock.now = atOffset(30_000);
    await service.status(event.id, "s2");

    clock.now = atOffset(90_000);
    expect(await service.reap(event.id)).toEqual([]);
    clock.now = atOffset(90_001);
    expect(await service.reap(event.id)).toEqual(["s1"]);

    expect(await service.isAdmitted(event.id, idle?.jti ?? "")).toBe(false);
    expect(await service.isAdmitted(event.id, polling?.jti ?? "")).toBe(true);
    expect(await service.status(event.id, "s1")).toEqual({ status: "NOT_QUEUED" });
    expect(await service.counts(event.id)).toEqual({ queued: 0, active: 1 });
  });

  test("AT-39: reaping frees a slot whose 30-minute admission expired, even while it polls", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 1);
    const [admission] = await service.admitTick(event, LIMITS);

    clock.now = atOffset(ADMISSION_TTL_MS - 1);
    await service.status(event.id, "s1");
    expect(await service.reap(event.id)).toEqual([]);
    clock.now = atOffset(ADMISSION_TTL_MS);
    await service.status(event.id, "s1");

    expect(await service.reap(event.id)).toEqual(["s1"]);
    expect(await service.isAdmitted(event.id, admission?.jti ?? "")).toBe(false);
  });

  test("AT-39: leave frees the slot and revokes the admission, making room for the next buyer", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 3);
    const [admission] = await service.admitTick(event, { admitRate: 5, maxActive: 2 });

    expect(await service.leave(event.id, "s1")).toEqual({ left: true });

    expect(await service.isAdmitted(event.id, admission?.jti ?? "")).toBe(false);
    expect(await service.status(event.id, "s1")).toEqual({ status: "NOT_QUEUED" });
    clock.now = atOffset(1000);
    expect(await service.admitTick(event, { admitRate: 5, maxActive: 2 })).toEqual([
      expect.objectContaining({ sessionId: "s3" }),
    ]);
  });

  test("AT-39: releaseSlot (order placed) frees the slot and revokes the admission", async () => {
    const clock = { now: AFTER_ON_SALE };
    const { event, service } = await queued(clock, 1);
    const [admission] = await service.admitTick(event, LIMITS);

    expect(await service.releaseSlot(event.id, "s1")).toBe(true);
    expect(await service.releaseSlot(event.id, "s1")).toBe(false);

    expect(await service.isAdmitted(event.id, admission?.jti ?? "")).toBe(false);
    expect(await service.counts(event.id)).toEqual({ queued: 0, active: 0 });
  });
});

describe("AdmissionPolicy (schedule)", () => {
  const policy = createScheduleAdmissionPolicy();
  const event = schedule();

  test("the queue is NOT_OPEN before queueOpensAt, ACTIVE from it up to queueClosesAt, CLOSED from then on", () => {
    expect(policy.phase(event, new Date("2027-05-01T09:54:59.999Z"))).toBe("NOT_OPEN");
    expect(policy.phase(event, event.queueOpensAt)).toBe("ACTIVE");
    expect(policy.phase(event, AFTER_ON_SALE)).toBe("ACTIVE");
    expect(policy.phase(event, new Date("2027-05-01T10:59:59.999Z"))).toBe("ACTIVE");
    expect(policy.phase(event, event.queueClosesAt)).toBe("CLOSED");
  });
});
