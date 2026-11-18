import { randomUUID } from "node:crypto";
import type { CausedEventInput } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, seedCatalog } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Buyer, createBookingService } from "./booking-service";
import { createPaymentSagaHandler } from "./payment-saga";

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
  return { order, seatId: seat.id, correlationId: hold.correlationId };
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

  test("refuses a payment captured after the deadline rather than confirming it", async () => {
    const { order } = await pendingOrder({ sessionId: "d".repeat(32), buyerKey: "d".repeat(32) });
    const { message } = paymentSucceeded(order, { capturedAt: LATE.toISOString() });

    await expect(
      db().$transaction((tx) => saga(tx, message, { emit: async () => undefined })),
    ).rejects.toThrow(/late/i);
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
  });
  test("returns poison for an unknown orderId and writes nothing", async () => {
    const { order } = await pendingOrder({ sessionId: "e".repeat(32), buyerKey: "e".repeat(32) });
    const { paymentId, message } = paymentSucceeded({ ...order, id: randomUUID() });
    const { emit, emitted } = recordingEmit();

    const outcome = await db().$transaction((tx) => saga(tx, message, { emit }));

    expect(outcome).toEqual({ outcome: "poison", reason: "unknown_order" });
    expect(await db().orderPayment.count({ where: { paymentId } })).toBe(0);
    expect(emitted).toEqual([]);
  });

  test("refuses a payment whose amount differs from the order total rather than confirming it", async () => {
    const { order } = await pendingOrder({ sessionId: "f".repeat(32), buyerKey: "f".repeat(32) });
    const { message } = paymentSucceeded(order, { amount: order.totalMinor + 1 });

    await expect(
      db().$transaction((tx) => saga(tx, message, { emit: async () => undefined })),
    ).rejects.toThrow(/amount_mismatch/);
    expect((await db().order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(0);
  });

  test("refuses a new payment for an already confirmed order rather than applying it twice", async () => {
    const { order } = await pendingOrder({ sessionId: "g".repeat(32), buyerKey: "g".repeat(32) });
    await db().$transaction((tx) => saga(tx, paymentSucceeded(order).message, recordingEmit()));
    const second = paymentSucceeded(order);

    await expect(
      db().$transaction((tx) => saga(tx, second.message, { emit: async () => undefined })),
    ).rejects.toThrow(/order_confirmed/);
    expect(await db().orderPayment.count({ where: { orderId: order.id } })).toBe(1);
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
