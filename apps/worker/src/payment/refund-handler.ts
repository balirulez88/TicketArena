import {
  type CausedEventInput,
  envelopeSchema,
  type JsonValue,
  type Logger,
  type PaymentRefundRequestedPayload,
  paymentRefundRequestedPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";

export interface RefundHandlerDeps {
  readonly clock: { now(): Date };
  readonly newId: () => string;
  readonly logger?: Logger;
}

const refundRequestedEnvelope = envelopeSchema(paymentRefundRequestedPayloadSchema);

/**
 * The mock provider's refund (spec: Mock Payment service): executes a `payment.refund_requested`
 * once per payment and emits `payment.refunded`. Bind it to a consumer runner with
 * `service: "payment"`, so the refund row, the dedupe row and the event share one transaction.
 *
 * `processed_messages` absorbs a redelivery, but not a duplicate request under a new event id (a
 * reconciler re-emit, or a request written twice). The refund row's primary key on `paymentId`
 * absorbs that: the insert skips an existing row, and a concurrent duplicate's insert waits on
 * the uncommitted row and then skips it, so exactly one transaction refunds and emits (AT-23).
 */
export function createRefundHandler(deps: RefundHandlerDeps) {
  const logger = deps.logger ?? silentLogger;

  return async function handleRefundRequested(
    tx: TransactionClient,
    message: { readonly data: string },
    { emit }: { readonly emit: (event: CausedEventInput) => Promise<unknown> },
  ): Promise<undefined> {
    const requested = refundRequestedEnvelope.parse(JSON.parse(message.data));
    const request = requested.payload;
    const refundedAt = deps.clock.now();
    const log = logger.child({ orderId: request.orderId, paymentId: request.paymentId });

    const inserted = await tx.paymentRefund.createMany({
      data: {
        paymentId: request.paymentId,
        orderId: request.orderId,
        amount: request.amount,
        currency: request.currency,
        reason: request.reason,
        refundedAt,
      },
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      log.info({ reason: request.reason }, "refund already executed");
      return undefined;
    }

    await emit({
      id: deps.newId(),
      type: "payment.refunded",
      version: 1,
      occurredAt: refundedAt.toISOString(),
      aggregateType: "payment",
      aggregateId: request.paymentId,
      orderId: request.orderId,
      ...(requested.holdId === undefined ? {} : { holdId: requested.holdId }),
      payload: {
        paymentId: request.paymentId,
        orderId: request.orderId,
        amount: request.amount,
        currency: request.currency,
        refundedAt: refundedAt.toISOString(),
        ...contactOf(request),
      },
    });
    log.info({ reason: request.reason }, "refund executed");
    return undefined;
  };
}

function contactOf(request: PaymentRefundRequestedPayload): { contact?: JsonValue } {
  const contact = request.contact;
  if (contact === undefined) {
    return {};
  }
  return {
    contact:
      contact.phone === undefined
        ? { email: contact.email }
        : { email: contact.email, phone: contact.phone },
  };
}
