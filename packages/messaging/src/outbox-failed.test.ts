import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectJetStreamMessageBus,
  createOutboxRelay,
  DEFAULT_MAX_PERMANENT_FAILURES,
  type MessageBus,
  measureOutboxFailures,
  OutboxRequeueRefused,
  readOutboxHistory,
  requeueFailedOutboxEvent,
  type ServiceName,
} from "./index.js";

// Terminal FAILED outbox rows (ADR 0022, ticket 59), against the real database and real NATS. A
// row fails permanently here the way it does in production: its event type maps to a subject no
// stream captures (`ta.unrouted.*`), which the broker itself reports.
const database = setupTestDatabase();
const nats = setupTestNats();
const MAIN_STREAM = `${nats.streamPrefix}TICKETARENA`;
const UNROUTED = "unrouted.event";
const CAP = 3;

let prisma: PrismaClient;
let bus: MessageBus;

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  bus = await connectJetStreamMessageBus({
    servers: nats.url,
    streamPrefix: nats.streamPrefix,
    subjectPrefix: nats.subjectPrefix,
  });
  await bus.ensureTopology();
});

afterAll(async () => {
  await bus.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
  await prisma.paymentOutboxEvent.deleteMany();
  await prisma.notificationOutboxEvent.deleteMany();
  const connection = await connect({ servers: nats.url });
  try {
    await (await jetstreamManager(connection)).streams.purge(MAIN_STREAM);
  } finally {
    await connection.close();
  }
});

interface Seed {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: object;
  readonly createdAt: Date;
}

let clockMs = Date.now();
function seed(eventType: string, aggregateId = crypto.randomUUID()): Seed {
  clockMs += 1;
  const id = crypto.randomUUID();
  return {
    id,
    aggregateType: "order",
    aggregateId,
    eventType,
    payload: {
      id,
      type: eventType,
      correlationId: crypto.randomUUID(),
      payload: { contact: { email: "buyer@example.com" }, nested: { b: 2, a: [1, "x"] } },
    },
    createdAt: new Date(clockMs),
  };
}

async function insert(service: ServiceName, rows: readonly Seed[]): Promise<void> {
  const data = rows.map((row) => ({ ...row }));
  switch (service) {
    case "booking":
      await prisma.outboxEvent.createMany({ data });
      return;
    case "payment":
      await prisma.paymentOutboxEvent.createMany({ data });
      return;
    case "notification":
      await prisma.notificationOutboxEvent.createMany({ data });
      return;
  }
}

const TABLES: Record<ServiceName, string> = {
  booking: '"public"."outbox_events"',
  payment: '"payment"."outbox_events"',
  notification: '"notification"."outbox_events"',
};

/** Every column of the row, the payload as the exact text Postgres stores. */
async function readRow(service: ServiceName, id: string): Promise<Record<string, unknown>> {
  const [row] = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT "id"::text, "aggregateType", "aggregateId", "eventType", "payload"::text AS "payload",
            "status"::text AS "status", "attempts", "lastError", "createdAt", "publishedAt",
            "permanentFailures", "failedAt"
     FROM ${TABLES[service]} WHERE "id" = $1::uuid`,
    id,
  );
  if (row === undefined) {
    throw new Error(`no ${service} outbox row ${id}`);
  }
  return row;
}

async function streamMessages(): Promise<{ msgId: string | undefined; subject: string }[]> {
  const connection = await connect({ servers: nats.url });
  try {
    const manager = await jetstreamManager(connection);
    const info = await manager.streams.info(MAIN_STREAM);
    const found: { msgId: string | undefined; subject: string }[] = [];
    for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq += 1) {
      const stored = await manager.streams.getMessage(MAIN_STREAM, { seq });
      if (stored !== null) {
        found.push({
          msgId: stored.header.get("Nats-Msg-Id") || undefined,
          subject: stored.subject,
        });
      }
    }
    return found;
  } finally {
    await connection.close();
  }
}

type Bindings = Record<string, unknown>;
type Line = Bindings & { readonly level: "info" | "warn" | "error"; readonly msg?: string };

function recordingLogger() {
  const lines: Line[] = [];
  const make = (bound: Bindings) => {
    const writer =
      (level: Line["level"]) =>
      (fields: object, msg?: string): void => {
        lines.push({ ...bound, ...fields, level, ...(msg === undefined ? {} : { msg }) });
      };
    return {
      info: writer("info"),
      warn: writer("warn"),
      error: writer("error"),
      child: (bindings: Bindings) => make({ ...bound, ...bindings }),
    };
  };
  return { logger: make({}), lines };
}

async function ticks(relay: { tick(): Promise<number> }, count: number): Promise<number> {
  let published = 0;
  for (let index = 0; index < count; index += 1) {
    published += await relay.tick();
  }
  return published;
}

describe("the permanent-failure cap", () => {
  it("defaults to a documented cap of 5 permanent failures", () => {
    expect(DEFAULT_MAX_PERMANENT_FAILURES).toBe(5);
  });

  for (const service of ["booking", "payment"] as const) {
    it(`marks a ${service} outbox row FAILED once its permanent failures reach the cap, and never claims it again`, async () => {
      const row = seed(UNROUTED);
      await insert(service, [row]);
      const relay = createOutboxRelay({ bus, prisma, service, maxPermanentFailures: CAP });

      await ticks(relay, CAP - 1);
      expect(await readRow(service, row.id)).toMatchObject({
        status: "PENDING",
        attempts: CAP - 1,
        permanentFailures: CAP - 1,
        failedAt: null,
      });

      const before = Date.now();
      await relay.tick();
      const failed = await readRow(service, row.id);
      expect(failed).toMatchObject({
        status: "FAILED",
        attempts: CAP,
        permanentFailures: CAP,
        publishedAt: null,
      });
      expect(String(failed["lastError"])).toMatch(/no stream matches subject/);
      expect(failed["failedAt"]).toBeInstanceOf(Date);
      expect((failed["failedAt"] as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);

      // Never claimed again: no attempt is added by later ticks.
      expect(await ticks(relay, 2)).toBe(0);
      expect(await readRow(service, row.id)).toEqual(failed);
    });
  }

  it("keeps a FAILED row whole: equal to the inserted row except the failure bookkeeping, never published", async () => {
    const row = seed(UNROUTED);
    await insert("booking", [row]);
    const inserted = await readRow("booking", row.id);
    const relay = createOutboxRelay({ bus, prisma, maxPermanentFailures: CAP });

    await ticks(relay, CAP + 2);

    const failed = await readRow("booking", row.id);
    const bookkeeping = ["status", "attempts", "lastError", "permanentFailures", "failedAt"];
    const without = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !bookkeeping.includes(key)));
    expect(without(failed)).toEqual(without(inserted));
    expect(failed["payload"]).toBe(inserted["payload"]);
    expect(failed["status"]).toBe("FAILED");
    expect(failed["publishedAt"]).toBeNull();
    expect((await streamMessages()).map((message) => message.msgId)).not.toContain(row.id);
  });
});

describe("the outbox history", () => {
  it("appends every permanent failure and status change, with the operator and reason of a requeue", async () => {
    const row = seed(UNROUTED);
    await insert("payment", [row]);
    const relay = createOutboxRelay({ bus, prisma, service: "payment", maxPermanentFailures: 2 });
    await ticks(relay, 3);

    const afterCap = await readOutboxHistory(prisma, "payment", row.id);
    expect(afterCap).toMatchObject([
      { kind: "PUBLISH_FAILED", attempt: 1, fromStatus: null, toStatus: null },
      { kind: "PUBLISH_FAILED", attempt: 2, fromStatus: null, toStatus: null },
      { kind: "STATUS_CHANGED", attempt: 2, fromStatus: "PENDING", toStatus: "FAILED" },
    ]);
    for (const entry of afterCap) {
      expect(entry.error).toMatch(/no stream matches subject/);
      expect(entry.at).toBeInstanceOf(Date);
    }

    await requeueFailedOutboxEvent(prisma, {
      service: "payment",
      outboxId: row.id,
      operator: "alice",
      reason: "stream subjects fixed",
    });

    const afterRequeue = await readOutboxHistory(prisma, "payment", row.id);
    expect(afterRequeue.slice(0, 3)).toEqual(afterCap);
    expect(afterRequeue).toHaveLength(4);
    expect(afterRequeue[3]).toMatchObject({
      kind: "STATUS_CHANGED",
      fromStatus: "FAILED",
      toStatus: "PENDING",
      attempt: 2,
      operator: "alice",
      reason: "stream subjects fixed",
    });
  });
});

describe("aggregate progress after a FAILED row (TD-038)", () => {
  it("publishes the later rows of a failed row's aggregate in order, and other aggregates throughout", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    // Interleaved creation, so B's rows are not simply "first".
    const a1 = seed(UNROUTED, a);
    const b1 = seed("order.placed", b);
    const a2 = seed("order.placed", a);
    const b2 = seed("order.confirmed", b);
    const a3 = seed("order.confirmed", a);
    const b3 = seed("order.expired", b);
    await insert("booking", [a1, b1, a2, b2, a3, b3]);
    const relay = createOutboxRelay({ bus, prisma, maxPermanentFailures: CAP });

    for (let tick = 0; tick < CAP + 3; tick += 1) {
      await relay.tick();
    }

    expect((await readRow("booking", a1.id))["status"]).toBe("FAILED");
    expect((await streamMessages()).map((message) => message.msgId)).toEqual([
      b1.id,
      b2.id,
      b3.id,
      a2.id,
      a3.id,
    ]);
  });
});

describe("alerting", () => {
  it("logs the transition to FAILED exactly once at error, with its identity and without the payload", async () => {
    const row = seed(UNROUTED);
    await insert("booking", [row]);
    const { logger, lines } = recordingLogger();
    const relay = createOutboxRelay({ bus, prisma, logger, maxPermanentFailures: CAP });

    await ticks(relay, CAP - 1);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);

    await ticks(relay, 3);
    const errors = lines.filter((line) => line.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      service: "booking",
      outboxId: row.id,
      aggregateType: "order",
      aggregateId: row.aggregateId,
      eventType: UNROUTED,
      attempts: CAP,
      msg: "outbox event FAILED: permanent publish failures reached the cap",
    });
    expect(String(errors[0]?.["lastError"])).toMatch(/no stream matches subject/);
    expect(errors[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(errors[0])).not.toContain("buyer@example.com");
  });
});

describe("manual recovery", () => {
  async function failedRow(service: ServiceName): Promise<Seed> {
    const row = seed(UNROUTED);
    await insert(service, [row]);
    await ticks(createOutboxRelay({ bus, prisma, service, maxPermanentFailures: 1 }), 1);
    expect((await readRow(service, row.id))["status"]).toBe("FAILED");
    return row;
  }

  it("requeues a FAILED row as PENDING with its permanent-failure count reset, under its own id", async () => {
    const row = await failedRow("booking");
    const before = await readRow("booking", row.id);

    await requeueFailedOutboxEvent(prisma, {
      service: "booking",
      outboxId: row.id,
      operator: "bob",
      reason: "retry after the fix",
    });

    expect(await readRow("booking", row.id)).toEqual({
      ...before,
      status: "PENDING",
      permanentFailures: 0,
      failedAt: null,
    });
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it("refuses a row that is not FAILED (PUBLISHED or PENDING), naming it and its status, and changes nothing", async () => {
    const published = seed("order.placed");
    const pending = seed(UNROUTED);
    await insert("booking", [published]);
    await createOutboxRelay({ bus, prisma }).tick();
    await insert("booking", [pending]);

    for (const [row, status] of [
      [published, "PUBLISHED"],
      [pending, "PENDING"],
    ] as const) {
      const before = await readRow("booking", row.id);
      const refusal = requeueFailedOutboxEvent(prisma, {
        service: "booking",
        outboxId: row.id,
        operator: "bob",
        reason: "try",
      });
      await expect(refusal).rejects.toBeInstanceOf(OutboxRequeueRefused);
      await expect(refusal).rejects.toThrow(
        `booking outbox row ${row.id} is ${status}, not FAILED`,
      );
      expect(await readRow("booking", row.id)).toEqual(before);
      expect(await readOutboxHistory(prisma, "booking", row.id)).toEqual([]);
    }
  });

  it("refuses an unknown id, naming it", async () => {
    const unknown = crypto.randomUUID();
    await expect(
      requeueFailedOutboxEvent(prisma, {
        service: "payment",
        outboxId: unknown,
        operator: "bob",
        reason: "try",
      }),
    ).rejects.toThrow(`payment outbox row ${unknown} does not exist`);
  });

  it("refuses a requeue without an operator or a reason", async () => {
    const row = await failedRow("notification");
    for (const missing of [
      { operator: " ", reason: "fixed" },
      { operator: "bob", reason: "" },
    ]) {
      await expect(
        requeueFailedOutboxEvent(prisma, { service: "notification", outboxId: row.id, ...missing }),
      ).rejects.toThrow(/operator and a reason/);
    }
    expect((await readRow("notification", row.id))["status"]).toBe("FAILED");
  });
});

describe("failure metrics", () => {
  const zero = { failed: 0, oldestFailedAgeMs: null, failedTransitions: 0 };

  it("reports zero for every service when nothing failed", async () => {
    await insert("booking", [seed("order.placed")]);

    expect(await measureOutboxFailures({ prisma, now: new Date() })).toEqual({
      booking: zero,
      payment: zero,
      notification: zero,
    });
  });

  it("reports one FAILED row with its age and transition", async () => {
    const row = seed(UNROUTED);
    await insert("booking", [row]);
    await ticks(createOutboxRelay({ bus, prisma, maxPermanentFailures: 1 }), 1);
    const failedAt = (await readRow("booking", row.id))["failedAt"] as Date;

    expect(
      await measureOutboxFailures({ prisma, now: new Date(failedAt.getTime() + 5000) }),
    ).toEqual({
      booking: { failed: 1, oldestFailedAgeMs: 5000, failedTransitions: 1 },
      payment: zero,
      notification: zero,
    });
  });

  it("reports several services separately, the oldest FAILED row's age, and transitions of requeued rows", async () => {
    const [b1, b2, p1] = [seed(UNROUTED), seed(UNROUTED), seed(UNROUTED)];
    await insert("booking", [b1]);
    await ticks(createOutboxRelay({ bus, prisma, maxPermanentFailures: 1 }), 1);
    await insert("booking", [b2]);
    await insert("payment", [p1]);
    await ticks(createOutboxRelay({ bus, prisma, maxPermanentFailures: 1 }), 1);
    await ticks(createOutboxRelay({ bus, prisma, service: "payment", maxPermanentFailures: 1 }), 1);
    await requeueFailedOutboxEvent(prisma, {
      service: "payment",
      outboxId: p1.id,
      operator: "carol",
      reason: "requeued once",
    });
    await ticks(createOutboxRelay({ bus, prisma, service: "payment", maxPermanentFailures: 1 }), 1);
    const oldest = (await readRow("booking", b1.id))["failedAt"] as Date;
    const now = new Date(oldest.getTime() + 60_000);

    const metrics = await measureOutboxFailures({ prisma, now });

    expect(metrics.booking).toEqual({ failed: 2, oldestFailedAgeMs: 60_000, failedTransitions: 2 });
    expect(metrics.payment).toMatchObject({ failed: 1, failedTransitions: 2 });
    expect(metrics.notification).toEqual(zero);
  });
});
