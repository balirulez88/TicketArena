import {
  envelopeSchema,
  type JsonValue,
  type Logger,
  type OrderPlacedPayload,
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
  /**
   * Share of attempts the provider captures, in [0, 1]; the draw comes from `random`. Defaults to
   * 1, so outside `+fail@` every attempt captures unless a caller configures failures.
   */
  readonly successRate?: number;
  readonly logger?: Logger;
}

const ATTEMPT_NO = 1;
const DUPLICATE_RESULT_MAGIC = "+dup@";
const DOUBLE_CAPTURE_MAGIC = "+double@";
const FINAL_FAILURE_MAGIC = "+fail@";
const LATE_CAPTURE_MAGIC = "+late@";
/**
 * `+late@`: the simulated provider stamps the capture this long after the order's payment
 * deadline. Provider time is what decides "on time" (spec: Payment saga), so the event is still
 * delivered at once and booking receives a late capture while the order is still open.
 */
const LATE_CAPTURE_AFTER_DEADLINE_MS = 1_000;
/** `+fail@`: the card is refused for good, so the attempt is final. */
const FINAL_FAILURE_REASON = "card_declined";
/** A random failure is treated as transient: the buyer may still pay before the deadline. */
const RANDOM_FAILURE_REASON = "provider_declined";
const orderPlacedEnvelope = envelopeSchema(orderPlacedPayloadSchema);

interface PaymentResult {
  readonly paymentId: string;
  readonly type: "payment.succeeded" | "payment.failed";
  readonly payload: JsonValue;
}

function attemptRow(order: OrderPlacedPayload, paymentId: string, attemptNo: number, at: Date) {
  return {
    paymentId,
    orderId: order.orderId,
    attemptNo,
    amount: order.amountMinor,
    currency: order.currency,
    contactEmail: order.contact.email,
    ...(order.contact.phone === undefined ? {} : { contactPhone: order.contact.phone }),
    createdAt: at,
  };
}

/** Records the captured attempt (two for `+double@`) and returns one result per attempt. */
async function recordCaptures(
  tx: TransactionClient,
  order: OrderPlacedPayload,
  at: Date,
  newId: () => string,
): Promise<PaymentResult[]> {
  const capturedAt = order.contact.email.includes(LATE_CAPTURE_MAGIC)
    ? new Date(new Date(order.paymentDeadline).getTime() + LATE_CAPTURE_AFTER_DEADLINE_MS)
    : at;
  // `+double@`: the provider charges the order twice. Both attempts are written here, in the one
  // transaction of one `order.placed`, so they are serialized per order by construction and each
  // takes its own `(orderId, attemptNo)`; neither fails, so no `final: true` is at stake.
  const attemptCount = order.contact.email.includes(DOUBLE_CAPTURE_MAGIC) ? 2 : 1;
  const results: PaymentResult[] = [];
  for (let attemptNo = ATTEMPT_NO; attemptNo <= attemptCount; attemptNo += 1) {
    const paymentId = newId();
    await tx.paymentAttempt.create({
      data: { ...attemptRow(order, paymentId, attemptNo, at), status: "CAPTURED", capturedAt },
    });
    results.push({
      paymentId,
      type: "payment.succeeded",
      payload: {
        paymentId,
        orderId: order.orderId,
        attemptNo,
        amount: order.amountMinor,
        currency: order.currency,
        capturedAt: capturedAt.toISOString(),
      },
    });
  }
  return results;
}

/** Records the failed attempt 1 and returns its `payment.failed` result. */
async function recordFailure(
  tx: TransactionClient,
  order: OrderPlacedPayload,
  at: Date,
  outcome: { final: boolean; reason: string },
  newId: () => string,
): Promise<PaymentResult[]> {
  const paymentId = newId();
  await tx.paymentAttempt.create({
    data: {
      ...attemptRow(order, paymentId, ATTEMPT_NO, at),
      status: "FAILED",
      failureReason: outcome.reason,
    },
  });
  // Invariant (spec: Mock Payment service): `final: true` lets booking cancel the order and
  // free its seats, so it is never sent while another attempt may still capture or has.
  // The check sees committed attempts only. That suffices while the MVP records only attempt
  // 1: nothing else writes attempts concurrently. Whoever adds retries must serialize attempts
  // per order (in every branch) before this check holds under concurrency.
  const otherLive = await tx.paymentAttempt.count({
    where: {
      orderId: order.orderId,
      attemptNo: { not: ATTEMPT_NO },
      status: { in: ["ATTEMPTING", "CAPTURED"] },
    },
  });
  return [
    {
      paymentId,
      type: "payment.failed",
      payload: {
        paymentId,
        orderId: order.orderId,
        attemptNo: ATTEMPT_NO,
        final: outcome.final && otherLive === 0,
        reason: outcome.reason,
      },
    },
  ];
}

export type PaymentConsumerSteps = Required<
  Pick<ConsumerRunnerOptions, "beforeTransaction" | "handler">
>;

/**
 * The mock provider: one attempt per order (MVP), decided immediately: captured, or failed
 * (`+fail@` finally, a random failure non-finally); only `+double@` captures a second attempt.
 * It touches only the `payment` schema and learns about the order solely from `order.placed`
 * (ADR 0009). Spread the result into a consumer runner bound to `service: "payment"` so the
 * dedupe row and the result events share the handler's transaction.
 *
 * The provider latency is the `beforeTransaction` step, not part of the handler (TD-051): a wait
 * inside the runner's transaction would pin a pooled connection and, past the transaction
 * timeout, roll back and redeliver forever. A duplicate delivery still waits, then is skipped by
 * the dedupe insert, so the wait can never cause a second capture.
 */
export function createPaymentHandler(deps: PaymentHandlerDeps): PaymentConsumerSteps {
  const latency = deps.latencyMs ?? { min: 0, max: 0 };
  const logger = deps.logger ?? silentLogger;
  const successRate = deps.successRate ?? 1;

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
    const at = deps.clock.now();
    const outcome = attemptOutcome(order.contact.email);
    const results = outcome.captured
      ? await recordCaptures(tx, order, at, deps.newId)
      : await recordFailure(tx, order, at, outcome, deps.newId);

    // Duplicates are separate events (new ids) for the same payment: they get past broker and
    // consumer dedupe, so booking's ledger and decision are what must absorb them.
    const copies = order.contact.email.includes(DUPLICATE_RESULT_MAGIC) ? 2 : 1;
    for (const result of results) {
      for (let copy = 0; copy < copies; copy += 1) {
        await emit({
          id: deps.newId(),
          type: result.type,
          version: 1,
          occurredAt: at.toISOString(),
          aggregateType: "payment",
          aggregateId: result.paymentId,
          orderId: order.orderId,
          ...(placed.holdId === undefined ? {} : { holdId: placed.holdId }),
          payload: result.payload,
        });
      }
      logger.info(
        { orderId: order.orderId, paymentId: result.paymentId, copies, result: result.type },
        "payment attempted",
      );
    }
  }

  /** Magic emails decide first (spec: Mock Payment service); otherwise the injected Random. */
  function attemptOutcome(
    email: string,
  ): { captured: true } | { captured: false; final: boolean; reason: string } {
    if (email.includes(FINAL_FAILURE_MAGIC)) {
      return { captured: false, final: true, reason: FINAL_FAILURE_REASON };
    }
    if (email.includes(LATE_CAPTURE_MAGIC) || email.includes(DOUBLE_CAPTURE_MAGIC)) {
      return { captured: true };
    }
    if (deps.random.next() < successRate) {
      return { captured: true };
    }
    return { captured: false, final: false, reason: RANDOM_FAILURE_REASON };
  }

  return { beforeTransaction: awaitProviderLatency, handler: handleOrderPlaced };
}
