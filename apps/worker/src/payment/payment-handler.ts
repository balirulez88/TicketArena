import {
  envelopeSchema,
  type JsonValue,
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
/** `+double@`: the extra charge is the order's second attempt, with its own payment id. */
const DOUBLE_CAPTURE_ATTEMPT_NO = 2;
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

type PlacedOrder = ReturnType<typeof orderPlacedEnvelope.parse>["payload"];

/** The fields every attempt of the order shares; the outcome fields are added by the caller. */
function attemptRow(order: PlacedOrder, paymentId: string, attemptNo: number, at: Date) {
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

export type PaymentConsumerSteps = Required<
  Pick<ConsumerRunnerOptions, "beforeTransaction" | "handler">
>;

/**
 * The mock provider: one attempt per order (MVP; `+double@` adds a second capture), decided
 * immediately: captured, or failed (`+fail@` finally, a random failure non-finally). It touches only the
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
    context: HandlerContext,
  ): Promise<undefined> {
    const placed = orderPlacedEnvelope.parse(JSON.parse(message.data));
    const at = deps.clock.now();
    if (!deadlinePassed(placed.payload, at)) {
      await attemptPayment(tx, placed, at, context);
    }
    return undefined;
  }

  async function attemptPayment(
    tx: TransactionClient,
    placed: ReturnType<typeof orderPlacedEnvelope.parse>,
    at: Date,
    { emit }: HandlerContext,
  ): Promise<void> {
    const order = placed.payload;
    const paymentId = deps.newId();
    const outcome = attemptOutcome(order.contact.email);
    const attempt = attemptRow(order, paymentId, ATTEMPT_NO, at);

    const settled = outcome.captured
      ? { status: "CAPTURED" as const, capturedAt: captureTime(order, at) }
      : { status: "FAILED" as const, failureReason: outcome.reason };
    if (!(await recordAttempt(tx, { ...attempt, ...settled }))) {
      return;
    }

    let result: { type: "payment.succeeded" | "payment.failed"; payload: JsonValue };
    if (settled.status === "CAPTURED") {
      result = {
        type: "payment.succeeded",
        payload: {
          paymentId,
          orderId: order.orderId,
          attemptNo: ATTEMPT_NO,
          amount: order.amountMinor,
          currency: order.currency,
          capturedAt: settled.capturedAt.toISOString(),
        },
      };
    } else {
      // Invariant (spec: Mock Payment service): `final: true` lets booking cancel the order and
      // free its seats, so it is never sent while another attempt may still capture or has.
      // The check sees committed attempts only. That suffices while the MVP records attempt 1
      // and, only for `+double@` (which never fails), attempt 2 in attempt 1's own transaction:
      // nothing else writes attempts concurrently. Whoever adds retries must serialize attempts
      // per order (in every branch) before this check holds under concurrency.
      const otherLive = await tx.paymentAttempt.count({
        where: {
          orderId: order.orderId,
          attemptNo: { not: ATTEMPT_NO },
          status: { in: ["ATTEMPTING", "CAPTURED"] },
        },
      });
      result = {
        type: "payment.failed",
        payload: {
          paymentId,
          orderId: order.orderId,
          attemptNo: ATTEMPT_NO,
          final: !outcome.captured && outcome.final && otherLive === 0,
          reason: settled.failureReason,
        },
      };
    }

    // Duplicates are separate events (new ids) for the same payment: they get past broker and
    // consumer dedupe, so booking's ledger and decision are what must absorb them.
    const copies = order.contact.email.includes(DUPLICATE_RESULT_MAGIC) ? 2 : 1;
    for (let copy = 0; copy < copies; copy += 1) {
      await emit({
        id: deps.newId(),
        type: result.type,
        version: 1,
        occurredAt: at.toISOString(),
        aggregateType: "payment",
        aggregateId: paymentId,
        orderId: order.orderId,
        ...(placed.holdId === undefined ? {} : { holdId: placed.holdId }),
        payload: result.payload,
      });
    }
    logger.info(
      { orderId: order.orderId, paymentId, copies, result: result.type },
      "payment attempted",
    );

    if (settled.status === "CAPTURED" && order.contact.email.includes(DOUBLE_CAPTURE_MAGIC)) {
      await captureAgain(tx, placed, at, settled.capturedAt, emit);
    }
  }

  /**
   * `+double@`: the provider charges the order a second time, as attempt 2 with a new payment id,
   * so booking sees two distinct captures for one order and must refund the extra one (AT-21).
   * Attempts per order stay serialized: only the transaction whose attempt 1 insert succeeded
   * reaches this point, and a concurrent repeat of the `order.placed` waits on that uncommitted
   * attempt 1 and then skips (`recordAttempt`), so it never writes attempt 2. A plain insert, not
   * a skipped duplicate: under that guarantee a conflict on attempt 2 would be a bug.
   */
  async function captureAgain(
    tx: TransactionClient,
    placed: ReturnType<typeof orderPlacedEnvelope.parse>,
    at: Date,
    capturedAt: Date,
    emit: HandlerContext["emit"],
  ): Promise<void> {
    const order = placed.payload;
    const paymentId = deps.newId();
    await tx.paymentAttempt.create({
      data: {
        ...attemptRow(order, paymentId, DOUBLE_CAPTURE_ATTEMPT_NO, at),
        status: "CAPTURED",
        capturedAt,
      },
    });
    await emit({
      id: deps.newId(),
      type: "payment.succeeded",
      version: 1,
      occurredAt: at.toISOString(),
      aggregateType: "payment",
      aggregateId: paymentId,
      orderId: order.orderId,
      ...(placed.holdId === undefined ? {} : { holdId: placed.holdId }),
      payload: {
        paymentId,
        orderId: order.orderId,
        attemptNo: DOUBLE_CAPTURE_ATTEMPT_NO,
        amount: order.amountMinor,
        currency: order.currency,
        capturedAt: capturedAt.toISOString(),
      },
    });
    logger.info({ orderId: order.orderId, paymentId }, "payment captured a second time");
  }

  /**
   * Inserts the attempt unless the order already has one (TD-053). `processed_messages` absorbs a
   * redelivery, but not an `order.placed` repeated under a new event id; the `(orderId, attemptNo)`
   * key absorbs that, as `paymentId` does for refunds: the repeat is acked as handled and neither
   * attempts nor emits again, since the first attempt's result went out with it. A concurrent
   * repeat's insert waits on the uncommitted row and then skips it. Without this the insert's
   * unique violation would roll back and be redelivered forever.
   */
  async function recordAttempt(
    tx: TransactionClient,
    data: Parameters<TransactionClient["paymentAttempt"]["create"]>[0]["data"],
  ): Promise<boolean> {
    const inserted = await tx.paymentAttempt.createMany({ data, skipDuplicates: true });
    if (inserted.count === 0) {
      logger.info(
        { orderId: data.orderId, attemptNo: data.attemptNo },
        "order.placed skipped: the order already has this payment attempt",
      );
      return false;
    }
    return true;
  }

  /**
   * ADR 0011: a recovery replay can deliver order.placed long after its deadline. The order can no
   * longer be paid (booking expires it), so charging now would only capture money to refund. The
   * caller acks it as handled: the dedupe row commits, nothing else is written.
   */
  function deadlinePassed(order: { orderId: string; paymentDeadline: string }, at: Date): boolean {
    if (at.getTime() <= new Date(order.paymentDeadline).getTime()) {
      return false;
    }
    logger.info(
      { orderId: order.orderId, paymentDeadline: order.paymentDeadline },
      "order.placed skipped: its payment deadline has passed",
    );
    return true;
  }

  /** Provider time of a capture: `+late@` lands just after the order's payment deadline. */
  function captureTime(order: { contact: { email: string }; paymentDeadline: string }, at: Date) {
    return order.contact.email.includes(LATE_CAPTURE_MAGIC)
      ? new Date(new Date(order.paymentDeadline).getTime() + LATE_CAPTURE_AFTER_DEADLINE_MS)
      : at;
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
