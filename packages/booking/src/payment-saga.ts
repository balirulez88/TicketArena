import {
  type CausedEventInput,
  envelopeSchema,
  type Logger,
  paymentSucceededPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import type { Clock } from "./booking-service";

export interface PaymentSagaDeps {
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger?: Logger;
}

/** The slice of the runner's handler arguments the saga uses; the runner's types satisfy it. */
export interface SagaMessage {
  readonly data: string;
}

export interface SagaContext {
  readonly emit: (event: CausedEventInput) => Promise<unknown>;
}

const paymentSucceededEnvelope = envelopeSchema(paymentSucceededPayloadSchema);

interface LockedOrder {
  readonly id: string;
  readonly holdId: string;
  readonly status: string;
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
 * runner's transaction, so the order decision, the ledger row, the seat change, the dedupe row
 * and the outbox event commit or roll back together (ADR 0006).
 *
 * Only the first column of the decision matrix exists so far: a new, on-time payment for a
 * `PENDING_PAYMENT` order, plus the duplicate no-op. Every other case throws, so the message is
 * retried rather than silently dropping captured money.
 */
export function createPaymentSagaHandler(deps: PaymentSagaDeps) {
  const logger = deps.logger ?? silentLogger;

  return async function handlePaymentSucceeded(
    tx: TransactionClient,
    message: SagaMessage,
    { emit }: SagaContext,
  ): Promise<void> {
    const envelope = paymentSucceededEnvelope.parse(JSON.parse(message.data));
    const payment = envelope.payload;
    const log = logger.child({ orderId: payment.orderId, paymentId: payment.paymentId });

    // Lock order first: concurrent events for one order serialize here, so the decision below
    // always sees the effect of the previous one.
    const [order] = await tx.$queryRaw<LockedOrder[]>`
      SELECT "id", "holdId", "status", "totalMinor", "currency", "contactEmail", "contactPhone",
             "paymentDeadline"
      FROM "orders" WHERE "id" = ${payment.orderId}::uuid FOR UPDATE`;
    if (order === undefined) {
      throw new Error(`payment.succeeded for unknown order ${payment.orderId}`);
    }

    const known = await tx.orderPayment.findUnique({ where: { paymentId: payment.paymentId } });
    if (known !== null) {
      log.info({ reason: "known_payment" }, "duplicate payment.succeeded ignored");
      return;
    }

    const capturedAt = new Date(payment.capturedAt);
    if (order.status !== "PENDING_PAYMENT") {
      throw new Error(`payment.succeeded for ${order.status} order ${order.id} is not handled yet`);
    }
    if (
      capturedAt.getTime() > order.paymentDeadline.getTime() ||
      payment.amount !== order.totalMinor ||
      payment.currency !== order.currency
    ) {
      throw new Error(`late or mismatched payment ${payment.paymentId} is not handled yet`);
    }

    const seatIds = await lockOrderSeats(tx, order.id);

    await tx.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    await tx.orderPayment.create({
      data: {
        paymentId: payment.paymentId,
        orderId: order.id,
        amount: payment.amount,
        currency: payment.currency,
        capturedAt,
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
      id: deps.newId(),
      type: "order.confirmed",
      version: 1,
      occurredAt: deps.clock.now().toISOString(),
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
    log.info({}, "order confirmed");
  };
}
