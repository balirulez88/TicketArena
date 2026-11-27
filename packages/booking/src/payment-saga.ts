import {
  type CausedEventInput,
  envelopeSchema,
  type Logger,
  paymentFailedPayloadSchema,
  paymentRefundedPayloadSchema,
  paymentSucceededPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import type { Clock } from "./booking-service";
import {
  type DecideContext,
  decide,
  type LedgerEntry,
  type OrphanObligationStatus,
  type RefundReason,
  type SagaDecision,
  type SagaEvent,
  type SagaOrderStatus,
} from "./saga-decision";

/** Saga counters, kept apart from the hold counters the admin dashboard reads. */
export type SagaMetric = "payment_attempt_failed" | "late_delivery_refund";

/** Per-event counters. Best-effort: a rejected increment is logged and never fails the saga. */
export interface SagaMetrics {
  increment(metric: SagaMetric, eventId: string): Promise<void>;
}

export interface PaymentSagaDeps {
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger?: Logger;
  readonly metrics?: SagaMetrics;
}

/** The slice of the runner's handler arguments the saga uses; the runner's types satisfy it. */
export interface SagaMessage {
  readonly data: string;
}

/**
 * Returned when the message must not count as processed; the consumer runner rolls the
 * transaction back and redelivers it later (its `HandlerOutcome`).
 */
export interface SagaOutcome {
  readonly outcome: "retry" | "poison";
  readonly reason: string;
}

export interface SagaContext {
  readonly emit: (event: CausedEventInput) => Promise<unknown>;
}

type SucceededEvent = Extract<SagaEvent, { type: "payment.succeeded" }>;

const REFUND_REQUESTED_EVENT = "payment.refund_requested";
/** Refund requests are keyed by payment: the reconciler re-emits per ledger row (spec). */
const REFUND_AGGREGATE = "order_payment";

const paymentSucceededEnvelope = envelopeSchema(paymentSucceededPayloadSchema);
const paymentFailedEnvelope = envelopeSchema(paymentFailedPayloadSchema);
const paymentRefundedEnvelope = envelopeSchema(paymentRefundedPayloadSchema);

/** Validates the message as the payment event its `type` names and reduces it for `decide`. */
function parsePaymentEvent(data: string): { orderId: string; event: SagaEvent } {
  const raw: unknown = JSON.parse(data);
  const type = typeof raw === "object" && raw !== null && "type" in raw ? raw.type : undefined;
  switch (type) {
    case "payment.succeeded": {
      const { payload } = paymentSucceededEnvelope.parse(raw);
      return {
        orderId: payload.orderId,
        event: {
          type,
          paymentId: payload.paymentId,
          amount: payload.amount,
          currency: payload.currency,
          capturedAt: new Date(payload.capturedAt),
        },
      };
    }
    case "payment.failed": {
      const { payload } = paymentFailedEnvelope.parse(raw);
      return {
        orderId: payload.orderId,
        event: { type, paymentId: payload.paymentId, final: payload.final },
      };
    }
    case "payment.refunded": {
      const { payload } = paymentRefundedEnvelope.parse(raw);
      return { orderId: payload.orderId, event: { type, paymentId: payload.paymentId } };
    }
    default:
      throw new Error(`booking saga cannot handle event type ${String(type)}`);
  }
}

interface LockedOrder {
  readonly id: string;
  readonly holdId: string;
  readonly eventId: string;
  readonly status: SagaOrderStatus;
  readonly totalMinor: number;
  readonly currency: string;
  readonly contactEmail: string;
  readonly contactPhone: string | null;
  readonly paymentDeadline: Date;
}

/** Locks the order's seats in id order so concurrent transactions take locks consistently. */
async function lockOrderSeats(tx: TransactionClient, orderId: string): Promise<string[]> {
  const lines = await tx.$queryRaw<{ seatId: string }[]>`
    SELECT "seatId" FROM "order_lines" WHERE "orderId" = ${orderId}::uuid ORDER BY "seatId"`;
  const seatIds = lines.map((line) => line.seatId);
  await tx.$queryRaw`
    SELECT "id" FROM "seats" WHERE "id" = ANY(${seatIds}::uuid[]) ORDER BY "id" FOR UPDATE`;
  return seatIds;
}

/**
 * The booking side of the payment saga (spec: Payment saga). Meant to run inside the consumer
 * runner's transaction, which has already inserted the `processed_messages` row (the dedupe
 * check), so the order decision, the ledger row, the seat change, the dedupe row and the outbox
 * event commit or roll back together (ADR 0006, ADR 0007).
 *
 * Every event goes through the pure `decide`; this handler only gathers its inputs under the
 * order lock and applies the result. Captured money the order cannot keep becomes a refund
 * obligation (a `REFUND_REQUESTED` ledger row, or an orphan obligation when the order is gone,
 * plus `payment.refund_requested`) in the same transaction, so it is never dropped silently. A transition no case below builds yet throws, so
 * the message is retried rather than acked.
 */
export function createPaymentSagaHandler(deps: PaymentSagaDeps) {
  const logger = deps.logger ?? silentLogger;

  // Fire-and-forget: a counter is best-effort and must never fail or delay the saga. It runs
  // inside the transaction, so a message that later rolls back and is retried can over-count.
  function count(metric: SagaMetric, eventId: string): void {
    const metrics = deps.metrics;
    if (metrics === undefined) {
      return;
    }
    const failed = (error: unknown) =>
      logger.warn({ err: error, metric, eventId }, "metric failed");
    try {
      metrics.increment(metric, eventId).catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  return async function handlePaymentEvent(
    tx: TransactionClient,
    message: SagaMessage,
    { emit }: SagaContext,
  ): Promise<SagaOutcome | undefined> {
    const { orderId, event } = parsePaymentEvent(message.data);
    const log = logger.child({ orderId, paymentId: event.paymentId });

    const { order, ledger, seatIds, context } = await lockSagaInputs(tx, orderId, event.paymentId);
    // One T per transaction, read after every lock is held (ADR 0005): every timestamp this
    // message writes uses it.
    const T = deps.clock.now();
    const decision = decide(order ?? null, ledger, event, T, context);

    switch (decision.kind) {
      case "noop":
        if (order !== undefined && decision.reason === "attempt_failed") {
          // A failed attempt is not a failed checkout (ADR 0006): the order stays open until its
          // deadline, so this log line and the counter are its only trace.
          count("payment_attempt_failed", order.eventId);
        }
        log.info({ reason: decision.reason }, `${event.type} is a noop`);
        return undefined;
      case "retry":
      case "poison":
        log.warn({ reason: decision.reason }, `${event.type} is ${decision.kind}`);
        return { outcome: decision.kind, reason: decision.reason };
      case "transition":
        log.info(
          { seatIds },
          order === undefined
            ? await applyOrphanTransition(tx, event, decision)
            : await applyTransition(tx, order, seatIds, event, decision, emit, deps.newId),
        );
        return undefined;
      case "refund": {
        const outcome = await applyRefund(tx, order, orderId, event, decision, emit, deps.newId);
        if (outcome.lateDeliveryEventId !== undefined) {
          count("late_delivery_refund", outcome.lateDeliveryEventId);
        }
        log.info({ reason: decision.reason }, outcome.line);
        return undefined;
      }
    }
  };
}

interface SagaInputs {
  readonly order: LockedOrder | undefined;
  readonly ledger: LedgerEntry[];
  readonly seatIds: string[];
  /** Holds the payment's orphan obligation, read only when the order is gone. */
  readonly context: DecideContext;
}

/**
 * Locks the order first, so concurrent events for one order serialize and the ledger read and
 * the decision always see the effect of the previous one. Seats change only for a
 * PENDING_PAYMENT order, so only then are they locked too. Without an order the payment's orphan
 * obligation is locked instead, if it exists: two `payment.refunded` then serialize on it. A
 * capture racing the one that is writing it finds no row to lock yet; the primary key catches
 * that one (`requestUnknownOrderRefund`).
 */
async function lockSagaInputs(
  tx: TransactionClient,
  orderId: string,
  paymentId: string,
): Promise<SagaInputs> {
  const [order] = await tx.$queryRaw<LockedOrder[]>`
    SELECT o."id", o."holdId", h."eventId", o."status", o."totalMinor", o."currency",
           o."contactEmail", o."contactPhone", o."paymentDeadline"
    FROM "orders" o JOIN "holds" h ON h."id" = o."holdId"
    WHERE o."id" = ${orderId}::uuid FOR UPDATE OF o`;
  if (order === undefined) {
    const [orphan] = await tx.$queryRaw<{ status: OrphanObligationStatus }[]>`
      SELECT "status"::text AS "status" FROM "orphan_refund_obligations"
      WHERE "paymentId" = ${paymentId}::uuid FOR UPDATE`;
    return {
      order,
      ledger: [],
      seatIds: [],
      context: orphan === undefined ? {} : { orphanObligation: orphan.status },
    };
  }
  const ledger = await tx.orderPayment.findMany({
    where: { orderId: order.id },
    select: { paymentId: true, disposition: true },
  });
  const seatIds = order.status === "PENDING_PAYMENT" ? await lockOrderSeats(tx, order.id) : [];
  return { order, ledger, seatIds, context: {} };
}

/**
 * Applies a `refund` decision: a refund obligation for a capture the order cannot keep, or, for an
 * order that no longer exists, an orphan obligation. Returns the log line and, for a
 * `late_delivery` refund, the event id whose counter it bumps.
 */
async function applyRefund(
  tx: TransactionClient,
  order: LockedOrder | undefined,
  orderId: string,
  event: SagaEvent,
  decision: Extract<SagaDecision, { kind: "refund" }>,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<{ line: string; lateDeliveryEventId: string | undefined }> {
  if (event.type !== "payment.succeeded") {
    throw notHandledYet(event, decision);
  }
  if (order === undefined) {
    const requested = await requestUnknownOrderRefund(tx, orderId, event, decision.at, emit, newId);
    return {
      line: requested ? "refund requested" : "refund already requested",
      lateDeliveryEventId: undefined,
    };
  }
  await insertRefundObligation(tx, order, event, decision.at);
  await emitRefundRequested(emit, newId, order, event, decision.reason, decision.at);
  return {
    line: "refund requested",
    lateDeliveryEventId: decision.reason === "late_delivery" ? order.eventId : undefined,
  };
}

/** Applies the transitions built so far and returns the log line; the rest throw (retried). */
async function applyTransition(
  tx: TransactionClient,
  order: LockedOrder,
  seatIds: string[],
  event: SagaEvent,
  decision: Extract<SagaDecision, { kind: "transition" }>,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<string> {
  if (event.type === "payment.succeeded" && decision.reason === "payment_on_time") {
    await confirm(tx, order, seatIds, event, decision.at, emit, newId);
    return "order confirmed";
  }
  if (decision.reason === "refund_completed") {
    await recordRefunded(tx, order, event);
    return "refund recorded";
  }
  if (decision.reason === "final_failure") {
    await cancel(tx, order, seatIds, decision.at, emit, newId);
    return "order cancelled";
  }
  if (event.type === "payment.succeeded" && decision.reason === "late_capture") {
    await expireForLateCapture(tx, order, seatIds, event, decision.at, emit, newId);
    return "order expired, late capture refund requested";
  }
  throw notHandledYet(event, decision);
}

/** Applies a transition for a payment whose order is gone: only its orphan obligation changes. */
async function applyOrphanTransition(
  tx: TransactionClient,
  event: SagaEvent,
  decision: Extract<SagaDecision, { kind: "transition" }>,
): Promise<string> {
  if (decision.reason !== "orphan_refund_completed") {
    throw notHandledYet(event, decision);
  }
  await recordOrphanRefunded(tx, event.paymentId);
  return "orphan refund recorded";
}

function notHandledYet(event: SagaEvent, decision: SagaDecision): Error {
  return new Error(
    `${event.type} decision ${decision.kind} (${decision.reason}) is not handled yet`,
  );
}

/**
 * Applies `refund_completed`: the payment's ledger row moves to REFUNDED, closing the obligation.
 * The order is unchanged and nothing is emitted: Notification hears `payment.refunded` itself.
 */
async function recordRefunded(
  tx: TransactionClient,
  order: LockedOrder,
  event: SagaEvent,
): Promise<void> {
  // Conditional on the disposition decide saw: zero rows means the decision is stale.
  const refunded = await tx.orderPayment.updateMany({
    where: {
      paymentId: event.paymentId,
      orderId: order.id,
      disposition: { in: ["REFUND_REQUESTED", "MANUAL_REVIEW"] },
    },
    data: { disposition: "REFUNDED" },
  });
  if (refunded.count !== 1) {
    throw new Error(`payment ${event.paymentId} has no open refund obligation`);
  }
}

/**
 * Applies `orphan_refund_completed`: the payment's orphan obligation moves to REFUNDED. Nothing is
 * emitted: there is no order or buyer, and Notification hears `payment.refunded` itself.
 */
async function recordOrphanRefunded(tx: TransactionClient, paymentId: string): Promise<void> {
  // Conditional on the state decide saw (the row is locked): zero rows means a stale decision.
  const refunded = await tx.orphanRefundObligation.updateMany({
    where: { paymentId, status: "REFUND_REQUESTED" },
    data: { status: "REFUNDED" },
  });
  if (refunded.count !== 1) {
    throw new Error(`payment ${paymentId} has no open orphan refund obligation`);
  }
}

/** Applies `payment_on_time`: order CONFIRMED, ledger APPLIED, seats SOLD, `order.confirmed`. */
async function confirm(
  tx: TransactionClient,
  order: LockedOrder,
  /** Already locked by the caller, before `T` was read. */
  seatIds: string[],
  payment: SucceededEvent,
  T: Date,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<void> {
  // Conditional on the state decide saw: zero rows means the decision is stale, never success.
  const confirmed = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING_PAYMENT" },
    data: { status: "CONFIRMED" },
  });
  if (confirmed.count !== 1) {
    throw new Error(`order ${order.id} is no longer PENDING_PAYMENT`);
  }
  await tx.orderPayment.create({
    data: {
      paymentId: payment.paymentId,
      orderId: order.id,
      amount: payment.amount,
      currency: payment.currency,
      capturedAt: payment.capturedAt,
      disposition: "APPLIED",
    },
  });
  const sold = await tx.seat.updateMany({
    where: { id: { in: seatIds }, status: "IN_CHECKOUT" },
    data: { status: "SOLD" },
  });
  if (sold.count !== seatIds.length) {
    throw new Error(`order ${order.id}: ${seatIds.length - sold.count} seat(s) not IN_CHECKOUT`);
  }

  await emit({
    id: newId(),
    type: "order.confirmed",
    version: 1,
    occurredAt: T.toISOString(),
    aggregateType: "order",
    aggregateId: order.id,
    orderId: order.id,
    holdId: order.holdId,
    payload: {
      orderId: order.id,
      seatIds,
      totalMinor: order.totalMinor,
      currency: order.currency,
      contact: contactOf(order),
    },
  });
}

/**
 * Applies `final_failure`: order CANCELLED, its in-checkout seats AVAILABLE, `order.cancelled`.
 * Ending the checkout is the only moment `IN_CHECKOUT` seats may be freed (spec: Expiry
 * invariant), so they are freed here, in the same transaction. No ledger row: nothing was captured.
 */
async function cancel(
  tx: TransactionClient,
  order: LockedOrder,
  /** Already locked by the caller, before `T` was read. */
  seatIds: string[],
  T: Date,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<void> {
  // Conditional on the state decide saw: zero rows means the decision is stale, never success.
  const cancelled = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING_PAYMENT" },
    data: { status: "CANCELLED" },
  });
  if (cancelled.count !== 1) {
    throw new Error(`order ${order.id} is no longer PENDING_PAYMENT`);
  }
  await freeCheckoutSeats(tx, order, seatIds);

  await emit({
    id: newId(),
    type: "order.cancelled",
    version: 1,
    occurredAt: T.toISOString(),
    aggregateType: "order",
    aggregateId: order.id,
    orderId: order.id,
    holdId: order.holdId,
    payload: { orderId: order.id, reason: "payment_failed", contact: contactOf(order) },
  });
}

/**
 * Applies `late_capture`: order EXPIRED, its in-checkout seats AVAILABLE, `order.expired`, and a
 * refund obligation for the capture. The seats are freed, never sold, even though they are still
 * free (AT-20): the buyer paid too late, so the money goes back instead.
 */
async function expireForLateCapture(
  tx: TransactionClient,
  order: LockedOrder,
  /** Already locked by the caller, before `T` was read. */
  seatIds: string[],
  payment: SucceededEvent,
  T: Date,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<void> {
  // Conditional on the state decide saw: zero rows means the decision is stale, never success.
  const expired = await tx.order.updateMany({
    where: { id: order.id, status: "PENDING_PAYMENT" },
    data: { status: "EXPIRED" },
  });
  if (expired.count !== 1) {
    throw new Error(`order ${order.id} is no longer PENDING_PAYMENT`);
  }
  await freeCheckoutSeats(tx, order, seatIds);
  await insertRefundObligation(tx, order, payment, T);

  await emit({
    id: newId(),
    type: "order.expired",
    version: 1,
    occurredAt: T.toISOString(),
    aggregateType: "order",
    aggregateId: order.id,
    orderId: order.id,
    holdId: order.holdId,
    payload: { orderId: order.id, contact: contactOf(order) },
  });
  await emitRefundRequested(emit, newId, order, payment, "late_capture", T);
}

/**
 * Ending the checkout is the only moment `IN_CHECKOUT` seats may be freed (spec: Expiry
 * invariant), so every caller does it in the transaction of that order transition.
 */
async function freeCheckoutSeats(
  tx: TransactionClient,
  order: LockedOrder,
  seatIds: string[],
): Promise<void> {
  const freed = await tx.seat.updateMany({
    where: { id: { in: seatIds }, status: "IN_CHECKOUT" },
    data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
  });
  if (freed.count !== seatIds.length) {
    throw new Error(`order ${order.id}: ${seatIds.length - freed.count} seat(s) not IN_CHECKOUT`);
  }
}

/** The durable half of a refund obligation; the reconciler later re-emits from this row. */
async function insertRefundObligation(
  tx: TransactionClient,
  order: LockedOrder,
  payment: SucceededEvent,
  T: Date,
): Promise<void> {
  await tx.orderPayment.create({
    data: {
      paymentId: payment.paymentId,
      orderId: order.id,
      amount: payment.amount,
      currency: payment.currency,
      capturedAt: payment.capturedAt,
      disposition: "REFUND_REQUESTED",
      refundRequestedAt: T,
    },
  });
}

async function emitRefundRequested(
  emit: SagaContext["emit"],
  newId: () => string,
  order: LockedOrder,
  payment: SucceededEvent,
  reason: RefundReason | "late_capture",
  T: Date,
): Promise<void> {
  await emit({
    id: newId(),
    type: REFUND_REQUESTED_EVENT,
    version: 1,
    occurredAt: T.toISOString(),
    aggregateType: REFUND_AGGREGATE,
    aggregateId: payment.paymentId,
    orderId: order.id,
    holdId: order.holdId,
    payload: {
      paymentId: payment.paymentId,
      orderId: order.id,
      amount: payment.amount,
      currency: payment.currency,
      reason,
      contact: contactOf(order),
    },
  });
}

/**
 * Refunds a capture whose order does not exist (a demo reset keeps orders, so it is not a cause).
 * There is no order to attach a ledger row to, so the orphan obligation is the durable record,
 * and its primary key is what makes the refund happen once per payment: a duplicate payment event
 * carries a new message id, so the consumer's `processed_messages` cannot catch it. A concurrent
 * duplicate's insert waits on the uncommitted row and then skips it, so only the transaction that
 * wrote the obligation emits the request, in that same transaction (ADR 0003).
 * Returns whether a request was written.
 */
async function requestUnknownOrderRefund(
  tx: TransactionClient,
  orderId: string,
  payment: SucceededEvent,
  T: Date,
  emit: SagaContext["emit"],
  newId: () => string,
): Promise<boolean> {
  const written = await tx.orphanRefundObligation.createMany({
    data: {
      paymentId: payment.paymentId,
      orderId,
      amount: payment.amount,
      currency: payment.currency,
      capturedAt: payment.capturedAt,
      status: "REFUND_REQUESTED",
      refundRequestedAt: T,
    },
    skipDuplicates: true,
  });
  if (written.count === 0) {
    return false;
  }
  await emit({
    id: newId(),
    type: REFUND_REQUESTED_EVENT,
    version: 1,
    occurredAt: T.toISOString(),
    aggregateType: REFUND_AGGREGATE,
    aggregateId: payment.paymentId,
    orderId,
    payload: {
      paymentId: payment.paymentId,
      orderId,
      amount: payment.amount,
      currency: payment.currency,
      reason: "unknown_order",
    },
  });
  return true;
}

function contactOf(order: LockedOrder): { email: string } | { email: string; phone: string } {
  return order.contactPhone === null
    ? { email: order.contactEmail }
    : { email: order.contactEmail, phone: order.contactPhone };
}
