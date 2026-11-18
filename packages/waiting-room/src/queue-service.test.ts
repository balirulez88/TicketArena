import { randomUUID } from "node:crypto";
import { setupTestRedis } from "@ticketarena/test-infra";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
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

  test("outside the queue window, join reports immediate admission eligibility and queues nothing", async () => {
    const event = schedule();
    const clock = { now: new Date("2027-05-01T09:00:00.000Z") };
    const service = serviceAt(clock);

    expect(await service.join(event, "too-early")).toEqual({ status: "ADMISSIBLE" });
    clock.now = new Date("2027-05-01T11:00:00.000Z");
    expect(await service.join(event, "after-close")).toEqual({ status: "ADMISSIBLE" });

    expect(await service.status(event.id, "too-early")).toEqual({ status: "NOT_QUEUED" });
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

describe("AdmissionPolicy (schedule)", () => {
  const policy = createScheduleAdmissionPolicy();
  const event = schedule();

  test("the queue is active from queueOpensAt up to, not including, queueClosesAt", () => {
    expect(policy.isQueueActive(event, new Date("2027-05-01T09:54:59.999Z"))).toBe(false);
    expect(policy.isQueueActive(event, event.queueOpensAt)).toBe(true);
    expect(policy.isQueueActive(event, AFTER_ON_SALE)).toBe(true);
    expect(policy.isQueueActive(event, event.queueClosesAt)).toBe(false);
  });
});
