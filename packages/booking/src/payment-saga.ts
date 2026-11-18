import {
  type CausedEventInput,
  envelopeSchema,
  type Logger,
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

export interface PaymentSagaDeps {
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger?: Logger;
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

interface LockedOrder {
  readonly id: string;
  readonly holdId: string;
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
 * order lock and applies the result. Only the on-time confirmation is applied so far; decisions
 * whose side effects later tickets build (refunds, expiry, cancellation) throw, so the message is
 * retried rather than captured money being dropped silently.
 */
export function createPaymentSagaHandler(deps: PaymentSagaDeps) {
  const logger = deps.logger ?? silentLogger;

  return async function handlePaymentSucceeded(
    tx: TransactionClient,
    message: SagaMessage,
    { emit }: SagaContext,
  ): Promise<SagaOutcome | undefined> {
    const envelope = paymentSucceededEnvelope.parse(JSON.parse(message.data));
    const payment = envelope.payload;
    const log = logger.child({ orderId: payment.orderId, paymentId: payment.paymentId });

    // Lock order first: concurrent events for one order serialize here, so the ledger read and
    // the decision below always see the effect of the previous one.
    const [order] = await tx.$queryRaw<LockedOrder[]>`
      SELECT "id", "holdId", "status", "totalMinor", "currency", "contactEmail", "contactPhone",
             "paymentDeadline"
      FROM "orders" WHERE "id" = ${payment.orderId}::uuid FOR UPDATE`;
    const ledger: LedgerEntry[] =
      order === undefined
        ? []
        : await tx.orderPayment.findMany({
            where: { orderId: order.id },
            select: { paymentId: true, disposition: true },
          });
    // Seats change only for a PENDING_PAYMENT order, so only then are they locked, and before T:
    // decision time is read after all locks are held (ADR 0005), so T never predates a lock wait.
    const seatIds = order?.status === "PENDING_PAYMENT" ? await lockOrderSeats(tx, order.id) : [];
    // One T per transaction: every timestamp this message writes uses it.
    const T = deps.clock.now();
    const event: SucceededEvent = {
      type: "payment.succeeded",
      paymentId: payment.paymentId,
      amount: payment.amount,
      currency: payment.currency,
      capturedAt: new Date(payment.capturedAt),
    };
    const decision = decide(order ?? null, ledger, event, T);

    switch (decision.kind) {
      case "noop":
        log.info({ reason: decision.reason }, "payment.succeeded is a noop");
        return undefined;
      case "retry":
      case "poison":
        log.warn({ reason: decision.reason }, `payment.succeeded is ${decision.kind}`);
        return { outcome: decision.kind, reason: decision.reason };
      case "transition":
        if (order !== undefined && decision.reason === "payment_on_time") {
          await confirm(tx, order, seatIds, event, decision.at, emit, deps.newId);
          log.info({}, "order confirmed");
          return undefined;
        }
        throw notHandledYet(decision);
      case "refund":
        throw notHandledYet(decision);
    }
  };
}

function notHandledYet(decision: SagaDecision): Error {
  return new Error(
    `payment.succeeded decision ${decision.kind} (${decision.reason}) is not handled yet`,
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
      contact: {
        email: order.contactEmail,
        ...(order.contactPhone === null ? {} : { phone: order.contactPhone }),
      },
    },
  });
}
