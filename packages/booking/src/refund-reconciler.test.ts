import { randomUUID } from "node:crypto";
import {
  type CausedEventInput,
  causedBy,
  envelopeSchema,
  parseEnvelope,
  paymentRefundRequestedPayloadSchema,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import { setupTestDatabase } from "@ticketarena/test-infra";
import { describe, expect, test } from "vitest";
import { createPaymentSagaHandler } from "./payment-saga";
import {
  block,
  bookingTestBed,
  failureOf,
  freshBuyer,
  NOW,
  settledUnlessBlocked,
  waitUntilBlocked,
  withTrigger,
} from "./testing";

const database = setupTestDatabase();
const { db, at, open, freeSeats } = bookingTestBed(database);

/** When the saga records every obligation of this file; the reconciler's clock moves from here. */
const REQUESTED_AT = new Date("2027-03-01T12:10:00.000Z");
const afterMinutes = (minutes: number) => new Date(REQUESTED_AT.getTime() + minutes * 60_000);

const requestEnvelope = envelopeSchema(paymentRefundRequestedPayloadSchema);
const saga = createPaymentSagaHandler({ clock: { now: () => REQUESTED_AT }, newId: randomUUID });

/** Writes each event to the transaction's outbox with the ids the consumer runner derives. */
function outboxEmit(tx: TransactionClient, data: string) {
  return async (event: CausedEventInput) => {
    const cause = parseEnvelope(JSON.parse(data));
    if (cause === undefined) {
      throw new Error("outboxEmit: the handled message is not an envelope");
    }
    const { aggregateType, aggregateId, ...fields } = event;
    await tx.outboxEvent.create({
      data: {
        id: event.id,
        aggregateType,
        aggregateId,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify({ ...fields, ...causedBy(cause) })),
      },
    });
  };
}

function paymentMessage(
  type: "payment.succeeded" | "payment.refunded",
  ids: { paymentId: string; orderId: string; correlationId: string },
  amount: number,
) {
  const payload =
    type === "payment.succeeded"
      ? {
          paymentId: ids.paymentId,
          orderId: ids.orderId,
          attemptNo: 1,
          amount,
          currency: "EUR",
          capturedAt: "2027-03-01T12:04:00.000Z",
        }
      : {
          paymentId: ids.paymentId,
          orderId: ids.orderId,
          amount,
          currency: "EUR",
          refundedAt: REQUESTED_AT.toISOString(),
        };
  return JSON.stringify({
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: REQUESTED_AT.toISOString(),
    correlationId: ids.correlationId,
    causationId: randomUUID(),
    orderId: ids.orderId,
    payload,
  });
}

async function handle(data: string): Promise<void> {
  const outcome = await db().$transaction((tx) =>
    saga(tx, { data }, { emit: outboxEmit(tx, data) }),
  );
  expect(outcome).toBeUndefined();
}

type Kind = "ledger" | "orphan";

interface Obligation {
  readonly paymentId: string;
  readonly orderId: string;
  readonly correlationId: string;
  readonly amount: number;
  /** The obligation's row, whichever table holds it, in one shape. */
  state(): Promise<{
    status: string;
    refundAttempts: number;
    refundRequestedAt: Date | null;
    refundLastRequestedAt: Date | null;
  }>;
  /** Payment's `payment.refunded` for this payment, handled by the booking saga. */
  refunded(): Promise<void>;
}

/**
 * A refund obligation recorded by the real saga at REQUESTED_AT: an on-time capture that reached
 * an expired order (a `late_delivery` ledger row), or one for an order booking never had (an
 * orphan obligation, reason `unknown_order`).
 */
async function obligation(kind: Kind): Promise<Obligation> {
  const paymentId = randomUUID();
  let orderId: string = randomUUID();
  let correlationId: string = randomUUID();
  let amount = 4200;
  if (kind === "ledger") {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await at(NOW).holdSeats(buyer, eventId, seatIds);
    const order = await at(NOW).placeOrder(
      buyer,
      hold.id,
      { email: "alice@example.com", phone: "+36301234567" },
      randomUUID(),
    );
    await at(new Date(order.paymentDeadline.getTime() + 61_000)).sweepExpired();
    orderId = order.id;
    correlationId = hold.correlationId;
    amount = order.totalMinor;
  }
  const ids = { paymentId, orderId, correlationId };
  await handle(paymentMessage("payment.succeeded", ids, amount));
  return {
    ...ids,
    amount,
    async state() {
      if (kind === "ledger") {
        const row = await db().orderPayment.findUniqueOrThrow({ where: { paymentId } });
        return {
          status: row.disposition,
          refundAttempts: row.refundAttempts,
          refundRequestedAt: row.refundRequestedAt,
          refundLastRequestedAt: row.refundLastRequestedAt,
        };
      }
      const row = await db().orphanRefundObligation.findUniqueOrThrow({ where: { paymentId } });
      return {
        status: row.status,
        refundAttempts: row.refundAttempts,
        refundRequestedAt: row.refundRequestedAt,
        refundLastRequestedAt: row.refundLastRequestedAt,
      };
    },
    refunded: () => handle(paymentMessage("payment.refunded", ids, amount)),
  };
}

/** Every `payment.refund_requested` for the payment, oldest first, as validated envelopes. */
async function requestsFor(paymentId: string) {
  const rows = await db().outboxEvent.findMany({
    where: { eventType: "payment.refund_requested", aggregateId: paymentId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ ...row, envelope: requestEnvelope.parse(row.payload) }));
}

/** One reconciler pass at `minutes` after REQUESTED_AT. */
function reconcileAt(minutes: number) {
  return at(afterMinutes(minutes)).reconcileRefunds();
}

const kinds: readonly Kind[] = ["ledger", "orphan"];

describe.each(kinds)("reconcileRefunds: a %s refund obligation", (kind) => {
  test("is left alone while its request is younger than 10 minutes", async () => {
    const owed = await obligation(kind);

    const result = await at(new Date(afterMinutes(10).getTime() - 1)).reconcileRefunds();

    expect(result.reEmitted).not.toContain(owed.paymentId);
    expect(await requestsFor(owed.paymentId)).toHaveLength(1);
    expect(await owed.state()).toMatchObject({ status: "REFUND_REQUESTED", refundAttempts: 0 });
  });

  test("is re-emitted through the outbox as the same request once 10 minutes old, and the re-emit is counted", async () => {
    const owed = await obligation(kind);

    const result = await reconcileAt(10);

    expect(result.reEmitted).toContain(owed.paymentId);
    const [original, again, ...more] = await requestsFor(owed.paymentId);
    expect(more).toEqual([]);
    expect(again?.id).not.toBe(original?.id);
    expect(again?.aggregateType).toBe("order_payment");
    expect(again?.envelope).toMatchObject({
      id: again?.id,
      type: "payment.refund_requested",
      occurredAt: afterMinutes(10).toISOString(),
      correlationId: owed.correlationId,
      causationId: null,
      orderId: owed.orderId,
    });
    expect(again?.envelope.holdId).toBe(original?.envelope.holdId);
    expect(again?.envelope.payload).toEqual(original?.envelope.payload);
    expect(await owed.state()).toEqual({
      status: "REFUND_REQUESTED",
      refundAttempts: 1,
      refundRequestedAt: REQUESTED_AT,
      refundLastRequestedAt: afterMinutes(10),
    });
  });

  test("ages each re-emit from the previous request, so re-emits come 10 minutes apart", async () => {
    const owed = await obligation(kind);

    await reconcileAt(10);
    await reconcileAt(15);
    await reconcileAt(19.99);
    expect(await requestsFor(owed.paymentId)).toHaveLength(2);

    await reconcileAt(20);
    expect(await requestsFor(owed.paymentId)).toHaveLength(3);
    expect(await owed.state()).toMatchObject({ refundAttempts: 2 });
  });

  test("moves to MANUAL_REVIEW, emitting nothing, once its third re-emit is 10 minutes old, and stays there", async () => {
    const owed = await obligation(kind);
    for (const minutes of [10, 20, 30]) {
      await reconcileAt(minutes);
    }
    expect(await owed.state()).toMatchObject({ status: "REFUND_REQUESTED", refundAttempts: 3 });

    const escalation = await reconcileAt(40);

    expect(escalation.escalated).toContain(owed.paymentId);
    expect(escalation.reEmitted).not.toContain(owed.paymentId);
    expect(await owed.state()).toMatchObject({ status: "MANUAL_REVIEW", refundAttempts: 3 });
    // Bounded: an obligation Payment never answers (a duplicate request it does not re-answer)
    // waits for a human instead of being re-emitted forever.
    await reconcileAt(50);
    await reconcileAt(120);
    expect(await requestsFor(owed.paymentId)).toHaveLength(4);
    expect(await owed.state()).toMatchObject({ status: "MANUAL_REVIEW" });
  });

  test("in MANUAL_REVIEW is still closed by payment.refunded", async () => {
    const owed = await obligation(kind);
    for (const minutes of [10, 20, 30, 40]) {
      await reconcileAt(minutes);
    }

    await owed.refunded();

    expect(await owed.state()).toMatchObject({ status: "REFUNDED" });
    await reconcileAt(60);
    expect(await requestsFor(owed.paymentId)).toHaveLength(4);
  });

  test("that is REFUNDED is never re-emitted", async () => {
    const owed = await obligation(kind);
    await owed.refunded();

    await reconcileAt(30);

    expect(await requestsFor(owed.paymentId)).toHaveLength(1);
    expect(await owed.state()).toMatchObject({ status: "REFUNDED", refundAttempts: 0 });
  });

  test("is re-emitted once when two reconciler passes run at the same time", async () => {
    const owed = await obligation(kind);
    const gate = await block(db(), (tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(7426023)`, {
      what: "the reconciler gate",
    });
    await withTrigger(
      db(),
      {
        table: "outbox_events",
        timing: "BEFORE INSERT",
        when: `NEW."aggregateId" = '${owed.paymentId}'`,
        body: "PERFORM pg_advisory_xact_lock(7426023);",
      },
      async () => {
        // The first pass claims the obligation and then waits, inside its transaction, on the
        // gate as it writes the outbox row; the second runs while the claim is held.
        const first = at(afterMinutes(10), { db: open() }).reconcileRefunds();
        try {
          const [firstPass] = await waitUntilBlocked(db(), gate.pid, {
            what: "the first pass",
            against: first,
          });
          if (firstPass === undefined) {
            throw new Error("the first pass is not blocked");
          }

          // Never waits on the first pass: SKIP LOCKED passes over the claimed row.
          const second = await settledUnlessBlocked(
            db(),
            firstPass.pid,
            at(afterMinutes(10), { db: open() }).reconcileRefunds(),
          );

          expect(second).toMatchObject({ status: "fulfilled" });
          const reEmitted =
            second !== "blocked" && second.status === "fulfilled" ? second.value : {};
          expect(reEmitted).toMatchObject({
            reEmitted: expect.not.arrayContaining([owed.paymentId]),
          });
        } finally {
          await gate.release();
        }
        expect((await first).reEmitted).toContain(owed.paymentId);
      },
    );
    expect(await requestsFor(owed.paymentId)).toHaveLength(2);
    expect(await owed.state()).toMatchObject({ refundAttempts: 1 });
  });
});

describe.each(kinds)("retryRefund: a %s refund obligation", (kind) => {
  async function inManualReview(): Promise<Obligation> {
    const owed = await obligation(kind);
    for (const minutes of [10, 20, 30, 40]) {
      await reconcileAt(minutes);
    }
    expect(await owed.state()).toMatchObject({ status: "MANUAL_REVIEW" });
    return owed;
  }

  test("moves MANUAL_REVIEW back to REFUND_REQUESTED, re-emits it and restarts the re-emit count", async () => {
    const owed = await inManualReview();

    const view = await at(afterMinutes(45)).retryRefund(owed.paymentId);

    expect(view).toEqual({
      paymentId: owed.paymentId,
      orderId: owed.orderId,
      amount: owed.amount,
      currency: "EUR",
      status: "REFUND_REQUESTED",
      refundAttempts: 0,
      refundRequestedAt: REQUESTED_AT,
      refundLastRequestedAt: afterMinutes(45),
    });
    const requests = await requestsFor(owed.paymentId);
    expect(requests).toHaveLength(5);
    expect(requests[4]?.envelope).toMatchObject({
      occurredAt: afterMinutes(45).toISOString(),
      correlationId: owed.correlationId,
      causationId: null,
    });
    expect(requests[4]?.envelope.payload).toEqual(requests[0]?.envelope.payload);
    expect(await owed.state()).toEqual({
      status: "REFUND_REQUESTED",
      refundAttempts: 0,
      refundRequestedAt: REQUESTED_AT,
      refundLastRequestedAt: afterMinutes(45),
    });

    // The reconciler takes it up again from the retry, 10 minutes later.
    await reconcileAt(54);
    expect(await requestsFor(owed.paymentId)).toHaveLength(5);
    await reconcileAt(55);
    expect(await owed.state()).toMatchObject({ status: "REFUND_REQUESTED", refundAttempts: 1 });
  });

  test("refuses an obligation that is not in MANUAL_REVIEW and changes nothing", async () => {
    const owed = await obligation(kind);
    const before = await owed.state();

    const error = await failureOf(at(afterMinutes(45)).retryRefund(owed.paymentId));

    expect(error).toMatchObject({ code: "REFUND_NOT_IN_MANUAL_REVIEW" });
    expect(String(error)).toContain(owed.paymentId);
    expect(await owed.state()).toEqual(before);
    expect(await requestsFor(owed.paymentId)).toHaveLength(1);
  });
});

describe("retryRefund: no refund obligation", () => {
  test("is NOT_FOUND for a payment booking holds no refund obligation for", async () => {
    const paymentId = randomUUID();

    const error = await failureOf(at(afterMinutes(45)).retryRefund(paymentId));

    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(String(error)).toContain(paymentId);
  });

  test("is NOT_FOUND for an APPLIED payment, which owes no refund, and changes nothing", async () => {
    const buyer = freshBuyer();
    const { eventId, seatIds } = await freeSeats(1);
    const hold = await at(NOW).holdSeats(buyer, eventId, seatIds);
    const order = await at(NOW).placeOrder(
      buyer,
      hold.id,
      { email: "alice@example.com" },
      randomUUID(),
    );
    const paymentId = randomUUID();
    const data = paymentMessage(
      "payment.succeeded",
      { paymentId, orderId: order.id, correlationId: hold.correlationId },
      order.totalMinor,
    );
    // Delivered on time, so the payment confirms the order instead of being refunded.
    const onTime = createPaymentSagaHandler({
      clock: { now: () => new Date(NOW.getTime() + 4 * 60_000) },
      newId: randomUUID,
    });
    await db().$transaction((tx) => onTime(tx, { data }, { emit: outboxEmit(tx, data) }));
    const before = await db().orderPayment.findUniqueOrThrow({ where: { paymentId } });
    expect(before.disposition).toBe("APPLIED");

    const error = await failureOf(at(afterMinutes(45)).retryRefund(paymentId));

    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(String(error)).toContain(paymentId);
    expect(await db().orderPayment.findUniqueOrThrow({ where: { paymentId } })).toEqual(before);
    expect(await requestsFor(paymentId)).toEqual([]);
  });
});

describe("AT-24 reconciler", () => {
  test("re-emits after 10 min, moves to MANUAL_REVIEW after 3 re-emits, and an operator retry moves it back", async () => {
    const owed = await obligation("ledger");

    await reconcileAt(10);
    expect(await requestsFor(owed.paymentId)).toHaveLength(2);
    await reconcileAt(20);
    await reconcileAt(30);
    await reconcileAt(40);
    expect(await owed.state()).toMatchObject({ status: "MANUAL_REVIEW", refundAttempts: 3 });
    expect(await requestsFor(owed.paymentId)).toHaveLength(4);

    await at(afterMinutes(41)).retryRefund(owed.paymentId);

    expect(await owed.state()).toMatchObject({ status: "REFUND_REQUESTED", refundAttempts: 0 });
    expect(await requestsFor(owed.paymentId)).toHaveLength(5);
  });
});
