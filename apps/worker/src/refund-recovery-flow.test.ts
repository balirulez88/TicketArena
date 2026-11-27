import { randomUUID } from "node:crypto";
import { createBookingService, createPaymentSagaHandler } from "@ticketarena/booking";
import { createPrismaClient, type PrismaClient } from "@ticketarena/db";
import { seedCatalog } from "@ticketarena/db/seed";
import {
  type ConsumerRunner,
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRefundHandler } from "./payment/refund-handler.js";

// A `payment.refunded` can be lost after Payment executed the refund (a FAILED outbox row, a
// dead-lettered message). Booking's reconciler then asks again, and Payment must answer with the
// refund it already executed, or the obligation would end in MANUAL_REVIEW although the money went
// back. Here the test is the bus: it delivers each outbox row it chooses to the real Payment and
// booking consumers, so "lost" is simply a row it never delivers.
const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;
let sequence = 0;

const START = new Date();
let now = START;
const clock = { now: () => now };
const minutesAfterStart = (minutes: number) => new Date(START.getTime() + minutes * 60_000);

beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: database.url, driver: "pg" });
  await seedCatalog(prisma, START);
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

interface Consumer {
  readonly runner: ConsumerRunner;
  readonly subject: string;
}

/** Payment's refund consumer and booking's saga consumer, each on a fresh durable and subject. */
async function consumers(): Promise<{ payment: Consumer; booking: Consumer }> {
  sequence += 1;
  const paymentSubject = `ta.payment.recovery-refund${sequence}`;
  const bookingSubject = `ta.payment.recovery-saga${sequence}`;
  return {
    payment: {
      subject: paymentSubject,
      runner: await createConsumerRunner({
        bus,
        prisma,
        service: "payment",
        consumer: `payment-recovery-refund${sequence}`,
        filterSubject: paymentSubject,
        handler: createRefundHandler({ clock, newId: randomUUID }),
      }),
    },
    booking: {
      subject: bookingSubject,
      runner: await createConsumerRunner({
        bus,
        prisma,
        service: "booking",
        consumer: `booking-recovery-saga${sequence}`,
        filterSubject: bookingSubject,
        handler: createPaymentSagaHandler({ clock, newId: randomUUID }),
      }),
    },
  };
}

async function deliver(to: Consumer, message: { id: string; payload: unknown }): Promise<void> {
  await bus.publish({
    subject: to.subject,
    data: JSON.stringify(message.payload),
    msgId: message.id,
  });
  await to.runner.pollOnce();
}

/** The payment's newest refund request in booking's outbox. */
async function latestRequest(paymentId: string) {
  return prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "payment.refund_requested", aggregateId: paymentId },
    orderBy: { createdAt: "desc" },
  });
}

/** The payment's newest `payment.refunded` in Payment's outbox, other than the `lost` ones. */
async function latestRefunded(paymentId: string, lost: readonly string[] = []) {
  return prisma.paymentOutboxEvent.findFirstOrThrow({
    where: { eventType: "payment.refunded", aggregateId: paymentId, id: { notIn: [...lost] } },
    orderBy: { createdAt: "desc" },
  });
}

function succeeded(input: {
  paymentId: string;
  orderId: string;
  correlationId: string;
  amount: number;
  capturedAt: Date;
}) {
  return {
    id: randomUUID(),
    payload: {
      id: randomUUID(),
      type: "payment.succeeded",
      version: 1,
      occurredAt: input.capturedAt.toISOString(),
      correlationId: input.correlationId,
      causationId: randomUUID(),
      orderId: input.orderId,
      payload: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        attemptNo: 1,
        amount: input.amount,
        currency: "EUR",
        capturedAt: input.capturedAt.toISOString(),
      },
    },
  };
}

/** Booking's obligation for the payment, whichever table holds it. */
async function obligationStatus(paymentId: string): Promise<string | undefined> {
  const ledger = await prisma.orderPayment.findUnique({ where: { paymentId } });
  if (ledger !== null) {
    return ledger.disposition;
  }
  return (await prisma.orphanRefundObligation.findUnique({ where: { paymentId } }))?.status;
}

/**
 * Payment executes the refund and its `payment.refunded` is lost; the reconciler's re-emit 10
 * minutes later gets the executed refund announced again, and booking closes the obligation.
 */
async function loseConfirmationThenReconcile(
  { payment, booking }: { payment: Consumer; booking: Consumer },
  paymentId: string,
  minutes: number,
): Promise<void> {
  await deliver(payment, await latestRequest(paymentId));
  expect(await prisma.paymentRefund.count({ where: { paymentId } })).toBe(1);
  // Lost: this payment.refunded is never delivered to booking.
  const lost = await latestRefunded(paymentId);
  expect(await obligationStatus(paymentId)).toBe("REFUND_REQUESTED");

  now = minutesAfterStart(minutes);
  const reconciled = await createBookingService({
    db: prisma,
    clock,
    newId: randomUUID,
  }).reconcileRefunds();
  expect(reconciled.reEmitted).toContain(paymentId);

  await deliver(payment, await latestRequest(paymentId));
  await deliver(booking, await latestRefunded(paymentId, [lost.id]));
}

describe("a refund whose payment.refunded was lost", () => {
  it("converges to REFUNDED for a ledger obligation, refunded exactly once", async () => {
    now = START;
    const pipes = await consumers();
    const booking = createBookingService({ db: prisma, clock, newId: randomUUID });
    const event = await prisma.event.findFirstOrThrow({ where: { demo: true } });
    const seat = await prisma.seat.findFirstOrThrow({
      where: { eventId: event.id, status: "AVAILABLE" },
      orderBy: { id: "asc" },
    });
    const buyer = { sessionId: "v".repeat(32), buyerKey: "v".repeat(32) };
    const hold = await booking.holdSeats(buyer, event.id, [seat.id]);
    const order = await booking.placeOrder(
      buyer,
      hold.id,
      { email: "buyer@example.com" },
      randomUUID(),
    );
    const paymentId = randomUUID();
    // Captured after the deadline: booking records a late_capture refund obligation.
    now = new Date(order.paymentDeadline.getTime() + 60_000);
    await deliver(
      pipes.booking,
      succeeded({
        paymentId,
        orderId: order.id,
        correlationId: hold.correlationId,
        amount: order.totalMinor,
        capturedAt: now,
      }),
    );
    expect(await obligationStatus(paymentId)).toBe("REFUND_REQUESTED");

    await loseConfirmationThenReconcile(
      pipes,
      paymentId,
      (now.getTime() - START.getTime()) / 60_000 + 10,
    );

    expect(await obligationStatus(paymentId)).toBe("REFUNDED");
    expect(await prisma.paymentRefund.count({ where: { paymentId } })).toBe(1);
  });

  it("converges to REFUNDED for an orphan obligation, refunded exactly once", async () => {
    now = START;
    const pipes = await consumers();
    const paymentId = randomUUID();
    await deliver(
      pipes.booking,
      succeeded({
        paymentId,
        orderId: randomUUID(),
        correlationId: randomUUID(),
        amount: 4200,
        capturedAt: START,
      }),
    );
    expect(await obligationStatus(paymentId)).toBe("REFUND_REQUESTED");

    await loseConfirmationThenReconcile(pipes, paymentId, 10);

    expect(await obligationStatus(paymentId)).toBe("REFUNDED");
    expect(await prisma.paymentRefund.count({ where: { paymentId } })).toBe(1);
  });

  it("converges to REFUNDED for a backfilled orphan obligation whose refund had already completed", async () => {
    now = START;
    const pipes = await consumers();
    const paymentId = randomUUID();
    await deliver(
      pipes.booking,
      succeeded({
        paymentId,
        orderId: randomUUID(),
        correlationId: randomUUID(),
        amount: 4200,
        capturedAt: START,
      }),
    );
    // As the previous worker left it: the unknown_order request in the outbox and no obligation.
    await prisma.orphanRefundObligation.delete({ where: { paymentId } });
    // Payment refunded it then; its payment.refunded found no obligation to close, so it is spent.
    await deliver(pipes.payment, await latestRequest(paymentId));
    expect(await prisma.paymentRefund.count({ where: { paymentId } })).toBe(1);
    const spent = await latestRefunded(paymentId);

    // The catch-up backfills an open obligation, which the next stale pass re-emits.
    now = minutesAfterStart(1);
    await createBookingService({ db: prisma, clock, newId: randomUUID }).reconcileRefunds();
    expect(await obligationStatus(paymentId)).toBe("REFUND_REQUESTED");
    now = minutesAfterStart(10);
    const reconciled = await createBookingService({
      db: prisma,
      clock,
      newId: randomUUID,
    }).reconcileRefunds();
    expect(reconciled.reEmitted).toContain(paymentId);
    await deliver(pipes.payment, await latestRequest(paymentId));
    await deliver(pipes.booking, await latestRefunded(paymentId, [spent.id]));

    expect(await obligationStatus(paymentId)).toBe("REFUNDED");
    expect(await prisma.paymentRefund.count({ where: { paymentId } })).toBe(1);
  });
});
