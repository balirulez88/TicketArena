import { randomUUID } from "node:crypto";
import {
  type CausedEventInput,
  orderExpiredPayloadSchema,
  paymentRefundRequestedPayloadSchema,
} from "@ticketarena/contracts";
import {
  createPrismaClient,
  type PrismaClient,
  seedCatalog,
  type TransactionClient,
} from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./booking-service";
import { createPaymentSagaHandler, type SagaMetric } from "./payment-saga";

const database = setupTestDatabase();
let prisma: PrismaClient | undefined;

function db(): PrismaClient {
  prisma ??= createPrismaClient({ connectionString: database.url, driver: "pg" });
  return prisma;
}

const PLACED_AT = new Date("2027-03-01T12:00:00.000Z");
const ON_TIME = new Date("2027-03-01T12:04:00.000Z");
const LATE = new Date("2027-03-01T12:05:01.000Z");
const alice: Buyer = { sessionId: "a".repeat(32), buyerKey: "a".repeat(32) };
const saga = createPaymentSagaHandler({ clock: { now: () => ON_TIME }, newId: randomUUID });

beforeAll(async () => {
  await seedCatalog(db(), PLACED_AT);
});

afterAll(async () => {
  await prisma?.$disconnect();
});

async function pendingOrder(buyer: Buyer = alice) {
  const event = await db().event.findFirstOrThrow({ where: { demo: true } });
  const seat = await db().seat.findFirstOrThrow({
    where: { eventId: event.id, status: "AVAILABLE" },
    orderBy: { id: "asc" },
  });
  const booking = createBookingService({
    db: db(),
    clock: { now: () => PLACED_AT },
    newId: randomUUID,
  });
  const hold = await booking.holdSeats(buyer, event.id, [seat.id]);
  const order = await booking.placeOrder(
    buyer,
    hold.id,
    { email: "alice@example.com" },
    randomUUID(),
  );
  return { order, seatId: seat.id, eventId: event.id, correlationId: hold.correlationId };
}

function paymentSucceeded(
  order: { id: string; totalMinor: number; currency: string },
  overrides: Record<string, unknown> = {},
) {
  const paymentId = randomUUID();
  return {
    paymentId,
    message: {
      data: JSON.stringify({
        id: randomUUID(),
        type: "payment.succeeded",
        version: 1,
        occurredAt: "2027-03-01T12:04:00.000Z",
        correlationId: randomUUID(),
        causationId: randomUUID(),
        orderId: order.id,
        payload: {
          paymentId,
          orderId: order.id,
          attemptNo: 1,
          amount: order.totalMinor,
          currency: order.currency,
          capturedAt: ON_TIME.toISOString(),
          ...overrides,
        },
      }),
    },
  };
}

/** Writes each event to the transaction's outbox, as the consumer runner's `emit` does. */
function outboxEmit(tx: TransactionClient) {
  return async (event: CausedEventInput) => {
    const { aggregateType, aggregateId, ...envelope } = event;
    await tx.outboxEvent.create({
      data: {
        id: event.id,
        aggregateType,
        aggregateId,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify(envelope)),
      },
    });
  };
}

function refundRequestsFor(paymentId: string) {
  return db().outboxEvent.findMany({
    where: { eventType: "payment.refund_requested", aggregateId: paymentId },
  });
}

/** An order the sweeper expired at its deadline plus grace; its seat is free again. */
async function expiredOrder(buyer: Buyer) {
  const pending = await pendingOrder(buyer);
  const sweeper = createBookingService({
    db: db(),
    clock: { now: () => new Date(pending.order.paymentDeadline.getTime() + 61_000) },
    newId: randomUUID,
  });
  await sweeper.sweepExpired();
  return pending;
}

function recordingEmit() {
  const emitted: CausedEventInput[] = [];
  return {
    emitted,
    emit: async (event: CausedEventInput) => {
      emitted.push(event);
    },
  };
}

describe("payment saga: payment.succeeded", () => {
  test("confirms the order, applies the payment, sells the seats and emits order.confirmed in one transaction", async () => {
    const { order, seatId } = await pendingOrder();
    const { paymentId, message } = paymentSucceeded(order);
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => saga(tx, message, { emit }));

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CONFIRMED",
    );
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      {
        paymentId,
        amount: order.totalMinor,
        currency: order.currency,
        capturedAt: ON_TIME,
        disposition: "APPLIED",
      },
    ]);
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
    expect(emitted).toMatchObject([
      {
        type: "order.confirmed",
        aggregateType: "order",
        aggregateId: order.id,
        orderId: order.id,
        payload: {
          orderId: order.id,
          seatIds: [seatId],
          totalMinor: order.totalMinor,
          currency: order.currency,
          contact: { email: "alice@example.com" },
        },
      },
    ]);
  });

  test("leaves neither CONFIRMED nor the APPLIED row when a failure follows the ledger insert", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "b".repeat(32),
      buyerKey: "b".repeat(32),
    });
    const { message } = paymentSucceeded(order);

    await expect(
      db().$transaction((tx) =>
        saga(tx, message, {
          emit: async () => {
            throw new Error("injected failure after the ledger insert");
          },
        }),
      ),
    ).rejects.toThrow("injected failure");

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "IN_CHECKOUT",
    );
  });

  test("changes nothing when the same payment is delivered again under a new event id", async () => {
    const { order } = await pendingOrder({ sessionId: "c".repeat(32), buyerKey: "c".repeat(32) });
    const first = paymentSucceeded(order);
    const second = {
      ...first.message,
      data: JSON.stringify({ ...JSON.parse(first.message.data), id: randomUUID() }),
    };
    const { emit, emitted } = recordingEmit();
    await db().$transaction((tx) => saga(tx, first.message, { emit }));

    await db().$transaction((tx) => saga(tx, second, { emit }));

    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  test("expires the order on a capture after the deadline, frees its seats and requests a refund in one transaction", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "d".repeat(32),
      buyerKey: "d".repeat(32),
    });
    const { paymentId, message } = paymentSucceeded(order, { capturedAt: LATE.toISOString() });
    const { emit, emitted } = recordingEmit();

    const outcome = await db().$transaction((tx) => saga(tx, message, { emit }));

    expect(outcome).toBeUndefined();
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "EXPIRED",
    );
    expect(await db().seat.findUniqueOrThrow({ where: { id: seatId } })).toMatchObject({
      status: "AVAILABLE",
      holdId: null,
      claimBuyerKey: null,
    });
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      {
        paymentId,
        amount: order.totalMinor,
        currency: order.currency,
        capturedAt: LATE,
        disposition: "REFUND_REQUESTED",
        refundRequestedAt: ON_TIME,
      },
    ]);
    expect(emitted).toMatchObject([
      {
        type: "order.expired",
        version: 1,
        occurredAt: ON_TIME.toISOString(),
        aggregateType: "order",
        aggregateId: order.id,
        orderId: order.id,
        payload: { orderId: order.id, contact: { email: "alice@example.com" } },
      },
      {
        type: "payment.refund_requested",
        version: 1,
        occurredAt: ON_TIME.toISOString(),
        aggregateType: "order_payment",
        aggregateId: paymentId,
        orderId: order.id,
        payload: {
          paymentId,
          orderId: order.id,
          amount: order.totalMinor,
          currency: order.currency,
          reason: "late_capture",
          contact: { email: "alice@example.com" },
        },
      },
    ]);
    expect(orderExpiredPayloadSchema.safeParse(emitted[0]?.payload).success).toBe(true);
    expect(paymentRefundRequestedPayloadSchema.safeParse(emitted[1]?.payload).success).toBe(true);
  });

  test("rolls the late-capture expiry back when the refund request cannot be written", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "p".repeat(32),
      buyerKey: "p".repeat(32),
    });
    const { message } = paymentSucceeded(order, { capturedAt: LATE.toISOString() });

    await expect(
      db().$transaction((tx) =>
        saga(tx, message, {
          emit: async (event) => {
            if (event.type === "payment.refund_requested") {
              throw new Error("injected outbox failure");
            }
          },
        }),
      ),
    ).rejects.toThrow("injected outbox failure");

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "IN_CHECKOUT",
    );
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
  });

  test("refunds a captured payment whose orderId no longer exists, with no ledger row and no contact", async () => {
    const order = { id: randomUUID(), totalMinor: 4_200, currency: "EUR" };
    const { paymentId, message } = paymentSucceeded(order);

    const outcome = await db().$transaction((tx) => saga(tx, message, { emit: outboxEmit(tx) }));

    expect(outcome).toBeUndefined();
    expect(await db().orderPayment.count({ where: { paymentId } })).toBe(0);
    const requests = await refundRequestsFor(paymentId);
    expect(requests).toMatchObject([
      {
        aggregateType: "order_payment",
        aggregateId: paymentId,
        payload: {
          type: "payment.refund_requested",
          orderId: order.id,
          payload: {
            paymentId,
            orderId: order.id,
            amount: 4_200,
            currency: "EUR",
            reason: "unknown_order",
          },
        },
      },
    ]);
    const stored: unknown = requests[0]?.payload;
    const payload =
      typeof stored === "object" && stored !== null && "payload" in stored
        ? stored.payload
        : undefined;
    expect(paymentRefundRequestedPayloadSchema.parse(payload).contact).toBeUndefined();
  });

  test("requests one refund for an unknown order however often its payment is delivered", async () => {
    const order = { id: randomUUID(), totalMinor: 4_200, currency: "EUR" };
    const first = paymentSucceeded(order);
    const duplicate = {
      data: JSON.stringify({ ...JSON.parse(first.message.data), id: randomUUID() }),
    };

    for (const message of [first.message, duplicate, first.message]) {
      await db().$transaction((tx) => saga(tx, message, { emit: outboxEmit(tx) }));
    }

    expect(await refundRequestsFor(first.paymentId)).toHaveLength(1);
  });

  test("requests one refund for an unknown order when two duplicates race", async () => {
    const order = { id: randomUUID(), totalMinor: 4_200, currency: "EUR" };
    const first = paymentSucceeded(order);
    const duplicate = {
      data: JSON.stringify({ ...JSON.parse(first.message.data), id: randomUUID() }),
    };
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested: () => void = () => undefined;
    const firstRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });

    // The first transaction writes its refund request and then stays open, so the duplicate
    // runs while that request is still uncommitted and invisible to it.
    const winner = db().$transaction(
      (tx) =>
        saga(tx, first.message, {
          emit: async (event) => {
            await outboxEmit(tx)(event);
            requested();
            await released;
          },
        }),
      { timeout: 30_000 },
    );
    await firstRequested;
    const racer = db().$transaction((tx) => saga(tx, duplicate, { emit: outboxEmit(tx) }), {
      timeout: 30_000,
    });
    // Wait (by condition, not by time) until the duplicate is blocked behind the first.
    for (;;) {
      const [waiting] = await db().$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
      if ((waiting?.count ?? 0n) > 0n) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await Promise.all([winner, racer]);

    expect(await refundRequestsFor(first.paymentId)).toHaveLength(1);
  });

  test("requests a refund for a payment whose amount differs from the order total rather than confirming it", async () => {
    const { order } = await pendingOrder({ sessionId: "f".repeat(32), buyerKey: "f".repeat(32) });
    const { paymentId, message } = paymentSucceeded(order, { amount: order.totalMinor + 1 });
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => saga(tx, message, { emit }));

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      { paymentId, amount: order.totalMinor + 1, disposition: "REFUND_REQUESTED" },
    ]);
    expect(emitted).toMatchObject([
      { type: "payment.refund_requested", payload: { paymentId, reason: "amount_mismatch" } },
    ]);
  });

  test("requests a refund for a new payment on an already confirmed order rather than applying it twice", async () => {
    const { order } = await pendingOrder({ sessionId: "g".repeat(32), buyerKey: "g".repeat(32) });
    await db().$transaction((tx) => saga(tx, paymentSucceeded(order).message, recordingEmit()));
    const second = paymentSucceeded(order);
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => saga(tx, second.message, { emit }));

    expect(
      await db().orderPayment.findMany({
        where: { orderId: order.id },
        select: { disposition: true },
        orderBy: { disposition: "asc" },
      }),
    ).toEqual([{ disposition: "APPLIED" }, { disposition: "REFUND_REQUESTED" }]);
    expect(emitted).toMatchObject([
      {
        type: "payment.refund_requested",
        payload: { paymentId: second.paymentId, reason: "order_confirmed" },
      },
    ]);
  });

  test("never treats a zero-row seat update as success: a seat no longer IN_CHECKOUT rolls the confirmation back", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "h".repeat(32),
      buyerKey: "h".repeat(32),
    });
    await db().seat.update({ where: { id: seatId }, data: { status: "AVAILABLE" } });
    const { message } = paymentSucceeded(order);

    await expect(
      db().$transaction((tx) => saga(tx, message, { emit: async () => undefined })),
    ).rejects.toThrow(/not IN_CHECKOUT/);
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
  });

  test("reads the clock once per transaction and stamps order.confirmed with that T", async () => {
    const { order } = await pendingOrder({ sessionId: "i".repeat(32), buyerKey: "i".repeat(32) });
    let reads = 0;
    const tickingSaga = createPaymentSagaHandler({
      clock: { now: () => new Date(ON_TIME.getTime() + 1_000 * reads++) },
      newId: randomUUID,
    });
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => tickingSaga(tx, paymentSucceeded(order).message, { emit }));

    expect(reads).toBe(1);
    expect(emitted).toMatchObject([{ occurredAt: ON_TIME.toISOString() }]);
  });
  test("reads T only after the order's seat locks are held (ADR 0005)", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "j".repeat(32),
      buyerKey: "j".repeat(32),
    });
    let reads = 0;
    const lockedSaga = createPaymentSagaHandler({
      clock: {
        now: () => {
          reads += 1;
          return ON_TIME;
        },
      },
      newId: randomUUID,
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seatLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      seatLocked = resolve;
    });
    // Another transaction holds the seat row lock, so the saga must block on it.
    const holder = db().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "seats" WHERE "id" = ${seatId}::uuid FOR UPDATE`;
        seatLocked();
        await released;
      },
      { timeout: 30_000 },
    );
    await locked;

    const confirming = db().$transaction(
      (tx) => lockedSaga(tx, paymentSucceeded(order).message, recordingEmit()),
      { timeout: 30_000 },
    );
    // Wait (by condition, not by time) until the saga is blocked on the seat lock.
    for (;;) {
      const [waiting] = await db().$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE "datname" = current_database() AND "wait_event_type" = 'Lock' AND "query" ILIKE '%FROM "seats"%FOR UPDATE%'`;
      if ((waiting?.count ?? 0n) > 0n) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const readsWhileBlocked = reads;
    release();
    await holder;
    await confirming;

    expect(readsWhileBlocked).toBe(0);
    expect(reads).toBe(1);
  });
});

function paymentFailed(orderId: string, final: boolean) {
  return {
    data: JSON.stringify({
      id: randomUUID(),
      type: "payment.failed",
      version: 1,
      occurredAt: "2027-03-01T12:04:00.000Z",
      correlationId: randomUUID(),
      causationId: randomUUID(),
      orderId,
      payload: {
        paymentId: randomUUID(),
        orderId,
        attemptNo: 1,
        final,
        reason: final ? "card_declined" : "provider_declined",
      },
    }),
  };
}

function recordingMetrics() {
  const counted: { metric: string; eventId: string }[] = [];
  return {
    counted,
    metrics: {
      increment: async (metric: SagaMetric, eventId: string) => {
        counted.push({ metric, eventId });
      },
    },
  };
}

describe("payment saga: payment.failed", () => {
  test("cancels a PENDING_PAYMENT order on a final failure, frees its seats and emits order.cancelled in one transaction", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "k".repeat(32),
      buyerKey: "k".repeat(32),
    });
    const { emit, emitted } = recordingEmit();

    const outcome = await db().$transaction((tx) =>
      saga(tx, paymentFailed(order.id, true), { emit }),
    );

    expect(outcome).toBeUndefined();
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CANCELLED",
    );
    expect(await db().seat.findUniqueOrThrow({ where: { id: seatId } })).toMatchObject({
      status: "AVAILABLE",
      holdId: null,
      claimBuyerKey: null,
    });
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
    expect(emitted).toMatchObject([
      {
        type: "order.cancelled",
        version: 1,
        occurredAt: ON_TIME.toISOString(),
        aggregateType: "order",
        aggregateId: order.id,
        orderId: order.id,
        payload: {
          orderId: order.id,
          reason: "payment_failed",
          contact: { email: "alice@example.com" },
        },
      },
    ]);
  });

  test("rolls the cancellation back when the outbox write fails: the order stays open and its seats stay in checkout", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "l".repeat(32),
      buyerKey: "l".repeat(32),
    });

    await expect(
      db().$transaction((tx) =>
        saga(tx, paymentFailed(order.id, true), {
          emit: async () => {
            throw new Error("injected outbox failure");
          },
        }),
      ),
    ).rejects.toThrow("injected outbox failure");

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "IN_CHECKOUT",
    );
  });

  test("leaves the order and seats alone on a non-final failure, writes no ledger row and counts the failed attempt", async () => {
    const { order, seatId, eventId } = await pendingOrder({
      sessionId: "m".repeat(32),
      buyerKey: "m".repeat(32),
    });
    const { counted, metrics } = recordingMetrics();
    const countingSaga = createPaymentSagaHandler({
      clock: { now: () => ON_TIME },
      newId: randomUUID,
      metrics,
    });
    const { emit, emitted } = recordingEmit();

    const outcome = await db().$transaction((tx) =>
      countingSaga(tx, paymentFailed(order.id, false), { emit }),
    );

    expect(outcome).toBeUndefined();
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe(
      "IN_CHECKOUT",
    );
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
    expect(emitted).toEqual([]);
    expect(counted).toEqual([{ metric: "payment_attempt_failed", eventId }]);
  });

  test("still settles a non-final failure when the metric cannot be recorded", async () => {
    const { order } = await pendingOrder({ sessionId: "n".repeat(32), buyerKey: "n".repeat(32) });
    const failingSaga = createPaymentSagaHandler({
      clock: { now: () => ON_TIME },
      newId: randomUUID,
      metrics: {
        increment: async () => {
          throw new Error("redis down");
        },
      },
    });

    await expect(
      db().$transaction((tx) => failingSaga(tx, paymentFailed(order.id, false), recordingEmit())),
    ).resolves.toBeUndefined();
  });

  test("does not cancel a confirmed order on a final failure", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "o".repeat(32),
      buyerKey: "o".repeat(32),
    });
    await db().$transaction((tx) => saga(tx, paymentSucceeded(order).message, recordingEmit()));
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => saga(tx, paymentFailed(order.id, true), { emit }));

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CONFIRMED",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("SOLD");
    expect(emitted).toEqual([]);
  });

  test("returns poison for a failure on an unknown orderId", async () => {
    const outcome = await db().$transaction((tx) =>
      saga(tx, paymentFailed(randomUUID(), true), recordingEmit()),
    );

    expect(outcome).toEqual({ outcome: "poison", reason: "unknown_order" });
  });
});

describe("payment saga: payment.succeeded on a settled order", () => {
  test.each([
    ["on time", ON_TIME, "late_delivery"],
    ["late", LATE, "order_expired"],
  ] as const)(
    "requests a refund for a capture (%s) on an EXPIRED order and never reclaims its free seats (AT-20)",
    async (_when, capturedAt, reason) => {
      const char = reason === "late_delivery" ? "q" : "r";
      const { order, seatId } = await expiredOrder({
        sessionId: char.repeat(32),
        buyerKey: char.repeat(32),
      });
      const { paymentId, message } = paymentSucceeded(order, {
        capturedAt: capturedAt.toISOString(),
      });
      const { emit, emitted } = recordingEmit();

      const outcome = await db().$transaction((tx) => saga(tx, message, { emit }));

      expect(outcome).toBeUndefined();
      expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "EXPIRED",
      );
      expect(await db().seat.findUniqueOrThrow({ where: { id: seatId } })).toMatchObject({
        status: "AVAILABLE",
        holdId: null,
      });
      expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
        { paymentId, disposition: "REFUND_REQUESTED", refundRequestedAt: ON_TIME, capturedAt },
      ]);
      expect(emitted).toMatchObject([
        {
          type: "payment.refund_requested",
          aggregateType: "order_payment",
          aggregateId: paymentId,
          orderId: order.id,
          payload: {
            paymentId,
            orderId: order.id,
            amount: order.totalMinor,
            currency: order.currency,
            reason,
            contact: { email: "alice@example.com" },
          },
        },
      ]);
    },
  );

  test("requests a refund for a capture on a CANCELLED order and leaves its seats alone", async () => {
    const { order, seatId } = await pendingOrder({
      sessionId: "s".repeat(32),
      buyerKey: "s".repeat(32),
    });
    await db().$transaction((tx) => saga(tx, paymentFailed(order.id, true), recordingEmit()));
    const { paymentId, message } = paymentSucceeded(order);
    const { emit, emitted } = recordingEmit();

    await db().$transaction((tx) => saga(tx, message, { emit }));

    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "CANCELLED",
    );
    expect((await db().seat.findUniqueOrThrow({ where: { id: seatId } })).status).toBe("AVAILABLE");
    expect(await db().orderPayment.findMany({ where: { orderId: order.id } })).toMatchObject([
      { paymentId, disposition: "REFUND_REQUESTED", refundRequestedAt: ON_TIME },
    ]);
    expect(emitted).toMatchObject([
      { type: "payment.refund_requested", payload: { paymentId, reason: "order_cancelled" } },
    ]);
  });

  test("requests one refund when the same payment reaches a settled order twice", async () => {
    const { order } = await expiredOrder({ sessionId: "t".repeat(32), buyerKey: "t".repeat(32) });
    const first = paymentSucceeded(order, { capturedAt: LATE.toISOString() });
    const duplicate = {
      data: JSON.stringify({ ...JSON.parse(first.message.data), id: randomUUID() }),
    };
    const { emit, emitted } = recordingEmit();

    for (const message of [first.message, duplicate]) {
      await db().$transaction((tx) => saga(tx, message, { emit }));
    }

    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(1);
    expect(emitted).toHaveLength(1);
  });

  test("counts late_delivery_refund for an on-time capture delivered after the order expired", async () => {
    const { order, eventId } = await expiredOrder({
      sessionId: "u".repeat(32),
      buyerKey: "u".repeat(32),
    });
    const { counted, metrics } = recordingMetrics();
    const countingSaga = createPaymentSagaHandler({
      clock: { now: () => ON_TIME },
      newId: randomUUID,
      metrics,
    });

    await db().$transaction((tx) =>
      countingSaga(tx, paymentSucceeded(order).message, recordingEmit()),
    );

    expect(counted).toEqual([{ metric: "late_delivery_refund", eventId }]);
  });
});
