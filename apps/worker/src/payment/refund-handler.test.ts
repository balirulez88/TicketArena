import { randomUUID } from "node:crypto";
import type { CausedEventInput } from "@ticketarena/contracts";
import { createPrismaClient, type PrismaClient, type TransactionClient } from "@ticketarena/db";
import {
  connectJetStreamMessageBus,
  createConsumerRunner,
  type MessageBus,
} from "@ticketarena/messaging";
import { setupTestDatabase, setupTestNats } from "@ticketarena/test-infra";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRefundHandler } from "./refund-handler.js";

const database = setupTestDatabase();
const nats = setupTestNats();

let prisma: PrismaClient;
let bus: MessageBus;
let sequence = 0;

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

const REFUNDED_AT = new Date("2027-03-01T12:10:00.000Z");
const handler = createRefundHandler({ clock: { now: () => REFUNDED_AT }, newId: randomUUID });

function refundRequested(
  overrides: { reason?: string; contact?: { email: string; phone?: string } | null } = {},
) {
  const paymentId = randomUUID();
  const orderId = randomUUID();
  const holdId = randomUUID();
  const contact =
    overrides.contact === undefined ? { email: "buyer+late@example.com" } : overrides.contact;
  const envelope = (id: string) => ({
    id,
    type: "payment.refund_requested",
    version: 1,
    occurredAt: "2027-03-01T12:05:01.000Z",
    correlationId: randomUUID(),
    causationId: randomUUID(),
    orderId,
    holdId,
    payload: {
      paymentId,
      orderId,
      amount: 12_500,
      currency: "EUR",
      reason: overrides.reason ?? "late_capture",
      ...(contact === null ? {} : { contact }),
    },
  });
  return { paymentId, orderId, holdId, envelope };
}

/** A payment consumer for refunds on a fresh durable name and subject. */
async function refundRunner() {
  sequence += 1;
  const subject = `ta.payment.refund-case${sequence}`;
  const consumer = `payment-refund-case${sequence}`;
  const runner = await createConsumerRunner({
    bus,
    prisma,
    service: "payment",
    consumer,
    filterSubject: subject,
    handler,
  });
  return { runner, subject, consumer };
}

function refundedEventsFor(paymentId: string) {
  return prisma.paymentOutboxEvent.findMany({
    where: { eventType: "payment.refunded", aggregateId: paymentId },
  });
}

/** Writes each event to payment's outbox, as the consumer runner's `emit` does. */
function paymentOutboxEmit(tx: TransactionClient) {
  return async (event: CausedEventInput) => {
    const { aggregateType, aggregateId, ...envelope } = event;
    await tx.paymentOutboxEvent.create({
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

describe("mock Payment refund handler", () => {
  it("executes a requested refund: one payment.refunds row and payment.refunded with the contact, through its own outbox", async () => {
    const request = refundRequested({
      contact: { email: "buyer+late@example.com", phone: "+36301234567" },
    });
    const message = request.envelope(randomUUID());
    const { runner, subject, consumer } = await refundRunner();

    await bus.publish({ subject, data: JSON.stringify(message), msgId: message.id });
    await runner.pollOnce();

    expect(
      await prisma.paymentRefund.findMany({ where: { paymentId: request.paymentId } }),
    ).toMatchObject([
      {
        paymentId: request.paymentId,
        orderId: request.orderId,
        amount: 12_500,
        currency: "EUR",
        reason: "late_capture",
        refundedAt: REFUNDED_AT,
      },
    ]);
    expect(await refundedEventsFor(request.paymentId)).toMatchObject([
      {
        aggregateType: "payment",
        aggregateId: request.paymentId,
        payload: {
          type: "payment.refunded",
          version: 1,
          orderId: request.orderId,
          holdId: request.holdId,
          correlationId: message.correlationId,
          causationId: message.id,
          payload: {
            paymentId: request.paymentId,
            orderId: request.orderId,
            amount: 12_500,
            currency: "EUR",
            refundedAt: REFUNDED_AT.toISOString(),
            contact: { email: "buyer+late@example.com", phone: "+36301234567" },
          },
        },
      },
    ]);
    expect(await prisma.paymentProcessedMessage.count({ where: { consumer } })).toBe(1);
  });

  it("refunds an unknown_order request, which has no contact, and emits payment.refunded without one", async () => {
    const request = refundRequested({ reason: "unknown_order", contact: null });
    const message = request.envelope(randomUUID());

    await prisma.$transaction((tx) =>
      handler(tx, { data: JSON.stringify(message) }, { emit: paymentOutboxEmit(tx) }),
    );

    expect(await prisma.paymentRefund.count({ where: { paymentId: request.paymentId } })).toBe(1);
    const [refunded] = await refundedEventsFor(request.paymentId);
    expect(refunded?.payload).toMatchObject({ payload: { paymentId: request.paymentId } });
    expect(refunded?.payload).not.toHaveProperty("payload.contact");
  });

  it("AT-23: a duplicate payment.refund_requested under a new event id yields one refund row and one payment.refunded", async () => {
    const request = refundRequested();
    const first = request.envelope(randomUUID());
    const duplicate = request.envelope(randomUUID());
    const { runner, subject, consumer } = await refundRunner();

    for (const message of [first, duplicate]) {
      await bus.publish({ subject, data: JSON.stringify(message), msgId: message.id });
      await runner.pollOnce();
    }

    expect(await prisma.paymentProcessedMessage.count({ where: { consumer } })).toBe(2);
    expect(await prisma.paymentRefund.count({ where: { paymentId: request.paymentId } })).toBe(1);
    expect(await refundedEventsFor(request.paymentId)).toMatchObject([
      { payload: { causationId: first.id } },
    ]);
  });

  it("AT-23: two duplicates that race yield one refund row and one payment.refunded", async () => {
    const request = refundRequested();
    const first = { data: JSON.stringify(request.envelope(randomUUID())) };
    const duplicate = { data: JSON.stringify(request.envelope(randomUUID())) };
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refunded: () => void = () => undefined;
    const firstRefunded = new Promise<void>((resolve) => {
      refunded = resolve;
    });

    // The first transaction has inserted its refund row and stays open, so the duplicate's
    // insert runs while that row is still uncommitted and invisible to it.
    const winner = prisma.$transaction(
      (tx) =>
        handler(tx, first, {
          emit: async (event) => {
            await paymentOutboxEmit(tx)(event);
            refunded();
            await released;
          },
        }),
      { timeout: 30_000 },
    );
    await firstRefunded;
    const racer = prisma.$transaction(
      (tx) => handler(tx, duplicate, { emit: paymentOutboxEmit(tx) }),
      { timeout: 30_000 },
    );
    // Wait (by condition, not by time) until the duplicate is blocked behind the first's row.
    for (;;) {
      const [waiting] = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT count(*) AS "count" FROM pg_stat_activity
        WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'`;
      if ((waiting?.count ?? 0n) > 0n) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await Promise.all([winner, racer]);

    expect(await prisma.paymentRefund.count({ where: { paymentId: request.paymentId } })).toBe(1);
    expect(await refundedEventsFor(request.paymentId)).toHaveLength(1);
  });

  it("rejects a request whose payload is invalid, writing nothing", async () => {
    const request = refundRequested();
    const message = request.envelope(randomUUID());
    const invalid = { ...message, payload: { ...message.payload, amount: -1 } };

    await expect(
      prisma.$transaction((tx) =>
        handler(tx, { data: JSON.stringify(invalid) }, { emit: paymentOutboxEmit(tx) }),
      ),
    ).rejects.toThrow();
    expect(await prisma.paymentRefund.count({ where: { paymentId: request.paymentId } })).toBe(0);
  });
});
