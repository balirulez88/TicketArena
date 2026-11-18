import {
  envelopeSchema,
  type Logger,
  orderPlacedPayloadSchema,
  silentLogger,
} from "@ticketarena/contracts";
import type { TransactionClient } from "@ticketarena/db";
import type {
  ConsumerRunnerOptions,
  HandlerContext,
  ReceivedMessage,
} from "@ticketarena/messaging";

export interface PaymentClock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

/** Uniform in [0, 1). Injected so tests (and the demo) choose the outcome. */
export interface PaymentRandom {
  next(): number;
}

export interface PaymentHandlerDeps {
  readonly clock: PaymentClock;
  readonly random: PaymentRandom;
  readonly newId: () => string;
  /** Provider latency range; the wait is drawn from `random`. Defaults to none. */
  readonly latencyMs?: { readonly min: number; readonly max: number };
  readonly logger?: Logger;
}

const ATTEMPT_NO = 1;
const DUPLICATE_RESULT_MAGIC = "+dup@";
const orderPlacedEnvelope = envelopeSchema(orderPlacedPayloadSchema);

export type PaymentConsumerSteps = Required<
  Pick<ConsumerRunnerOptions, "beforeTransaction" | "handler">
>;

/**
 * The mock provider: one attempt per order (MVP), captured immediately. It touches only the
 * `payment` schema and learns about the order solely from `order.placed` (ADR 0009). Spread the
 * result into a consumer runner bound to `service: "payment"` so the dedupe row and the result
 * events share the handler's transaction.
 *
 * The provider latency is the `beforeTransaction` step, not part of the handler (TD-051): a wait
 * inside the runner's transaction would pin a pooled connection and, past the transaction
 * timeout, roll back and redeliver forever. A duplicate delivery still waits, then is skipped by
 * the dedupe insert, so the wait can never cause a second capture.
 */
export function createPaymentHandler(deps: PaymentHandlerDeps): PaymentConsumerSteps {
  const latency = deps.latencyMs ?? { min: 0, max: 0 };
  const logger = deps.logger ?? silentLogger;

  async function awaitProviderLatency(): Promise<void> {
    const waitMs = latency.min + deps.random.next() * (latency.max - latency.min);
    if (waitMs > 0) {
      await deps.clock.sleep(waitMs);
    }
  }

  async function handleOrderPlaced(
    tx: TransactionClient,
    message: ReceivedMessage,
    { emit }: HandlerContext,
  ): Promise<undefined> {
    const placed = orderPlacedEnvelope.parse(JSON.parse(message.data));
    const order = placed.payload;
    const capturedAt = deps.clock.now();
    const paymentId = deps.newId();

    await tx.paymentAttempt.create({
      data: {
        paymentId,
        orderId: order.orderId,
        attemptNo: ATTEMPT_NO,
        status: "CAPTURED",
        capturedAt,
        amount: order.amountMinor,
        currency: order.currency,
        contactEmail: order.contact.email,
        ...(order.contact.phone === undefined ? {} : { contactPhone: order.contact.phone }),
        createdAt: capturedAt,
      },
    });

    // Duplicates are separate events (new ids) for the same payment: they get past broker and
    // consumer dedupe, so booking's ledger is what must absorb them.
    const copies = order.contact.email.includes(DUPLICATE_RESULT_MAGIC) ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      await emit({
        id: deps.newId(),
        type: "payment.succeeded",
        version: 1,
        occurredAt: capturedAt.toISOString(),
        aggregateType: "payment",
        aggregateId: paymentId,
        orderId: order.orderId,
        ...(placed.holdId === undefined ? {} : { holdId: placed.holdId }),
        payload: {
          paymentId,
          orderId: order.orderId,
          attemptNo: ATTEMPT_NO,
          amount: order.amountMinor,
          currency: order.currency,
          capturedAt: capturedAt.toISOString(),
        },
      });
    }
    logger.info({ orderId: order.orderId, paymentId, copies }, "payment captured");
  }

  return { beforeTransaction: awaitProviderLatency, handler: handleOrderPlaced };
}
