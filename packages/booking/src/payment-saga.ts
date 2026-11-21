import {
  type CausedEventInput,
  envelopeSchema,
  type Logger,
  paymentFailedPayloadSchema,
  paymentSucceededPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import type { Clock } from "./booking-service";
import {
  decide,
  type LedgerEntry,
  type SagaDecision,
  type SagaEvent,
  type SagaOrderStatus,
} from "./saga-decision";

/** Saga counters, kept apart from the hold counters the admin dashboard reads. */
export type SagaMetric = "payment_attempt_failed";

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

const paymentSucceededEnvelope = envelopeSchema(paymentSucceededPayloadSchema);
const paymentFailedEnvelope = envelopeSchema(paymentFailedPayloadSchema);

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
 * order lock and applies the result. The on-time confirmation and the final-failure cancellation
 * are applied so far; decisions whose side effects later tickets build (refunds, late-capture
 * expiry) throw, so the message is retried rather than captured money being dropped silently.
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

    const { order, ledger, seatIds } = await lockSagaInputs(tx, orderId);
    // One T per transaction, read after every lock is held (ADR 0005): every timestamp this
    // message writes uses it.
    const T = deps.clock.now();
    const decision = decide(order ?? null, ledger, event, T);

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
        if (order === undefined) {
          throw notHandledYet(event, decision);
        }
        log.info(
          { seatIds },
          await applyTransition(tx, order, seatIds, event, decision, emit, deps.newId),
        );
        return undefined;
      case "refund":
        throw notHandledYet(event, decision);
    }
  };
}

/**
 * Locks the order first, so concurrent events for one order serialize and the ledger read and
 * the decision always see the effect of the previous one. Seats change only for a
 * PENDING_PAYMENT order, so only then are they locked too.
 */
async function lockSagaInputs(
  tx: TransactionClient,
  orderId: string,
): Promise<{ order: LockedOrder | undefined; ledger: LedgerEntry[]; seatIds: string[] }> {
  const [order] = await tx.$queryRaw<LockedOrder[]>`
    SELECT o."id", o."holdId", h."eventId", o."status", o."totalMinor", o."currency",
           o."contactEmail", o."contactPhone", o."paymentDeadline"
    FROM "orders" o JOIN "holds" h ON h."id" = o."holdId"
    WHERE o."id" = ${orderId}::uuid FOR UPDATE OF o`;
  if (order === undefined) {
    return { order, ledger: [], seatIds: [] };
  }
  const ledger = await tx.orderPayment.findMany({
    where: { orderId: order.id },
    select: { paymentId: true, disposition: true },
  });
  const seatIds = order.status === "PENDING_PAYMENT" ? await lockOrderSeats(tx, order.id) : [];
  return { order, ledger, seatIds };
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
  if (decision.reason === "final_failure") {
    await cancel(tx, order, seatIds, decision.at, emit, newId);
    return "order cancelled";
  }
  throw notHandledYet(event, decision);
}

function notHandledYet(event: SagaEvent, decision: SagaDecision): Error {
  return new Error(
    `${event.type} decision ${decision.kind} (${decision.reason}) is not handled yet`,
  );
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
  const freed = await tx.seat.updateMany({
    where: { id: { in: seatIds }, status: "IN_CHECKOUT" },
    data: { status: "AVAILABLE", holdId: null, claimBuyerKey: null },
  });
  if (freed.count !== seatIds.length) {
    throw new Error(`order ${order.id}: ${seatIds.length - freed.count} seat(s) not IN_CHECKOUT`);
  }

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

function contactOf(order: LockedOrder): { email: string } | { email: string; phone: string } {
  return order.contactPhone === null
    ? { email: order.contactEmail }
    : { email: order.contactEmail, phone: order.contactPhone };
}
